const { redact } = require("./ipmi")
const { parseSensorOutput, toSensorData } = require("./sensors")
const { FAILSAFE_RECOVERY_MARGIN, calculateManualFanSpeed, findOverheatedSensor, getHottestSensor, getTemperatureSensors } = require("./fanControl")

// Repeat an unchanged log line (fan target, recurring error) at most this often
const SUMMARY_INTERVAL_MS = 10 * 60 * 1000

function createState() {
	return {
		sensordata: [],
		mode: "unknown",
		// What the iDRAC was last successfully told: "manual", "automatic" or null (unknown)
		appliedMode: null,
		targetFanSpeed: null,
		controlTemperature: null,
		highestTemperature: null,
		hottestSensor: null,
		failsafeKind: null,
		failsafeReason: null,
		lastUpdate: null,
		lastError: null,
		consecutiveFailures: 0,
		cycleFailed: false,
		lastSpeedLog: { at: 0, speed: null },
		lastErrorLog: { at: 0, message: null },
	}
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms).unref?.())
}

function describeOverheat({ sensor, value, limit }) {
	if (limit === null) return `${sensor.name} is ${value} °C and the iDRAC reports it as ${sensor.status === "nr" ? "non-recoverable" : "critical"}`
	return `${sensor.name} is ${value} °C, at or above its ${limit} °C limit`
}

class FanController {
	constructor({ ipmi, getServers, pollIntervalMs = 30000, failsafeReadFailures = 3, log = console, now = Date.now, onPoll = () => {}, onError = () => {}, onCycle = () => {} }) {
		this.ipmi = ipmi
		this.getServers = getServers
		this.pollIntervalMs = pollIntervalMs
		this.failsafeReadFailures = failsafeReadFailures
		this.log = log
		this.now = now
		this.onPoll = onPoll
		this.onError = onError
		this.onCycle = onCycle
		this.states = new Map()
		this.queues = new Map()
		this.stopping = false
		this.timer = null
		this.startedAt = now()
		this.lastCycleAt = null
		this.lastCycleDurationMs = null
	}

	state(id) {
		if (!this.states.has(id)) this.states.set(id, createState())
		return this.states.get(id)
	}

	status(id) {
		const state = this.state(id)
		return {
			mode: state.mode,
			targetFanSpeed: state.targetFanSpeed,
			controlTemperature: state.controlTemperature,
			highestTemperature: state.highestTemperature,
			hottestSensor: state.hottestSensor,
			failsafeReason: state.failsafeReason,
			lastUpdate: state.lastUpdate,
			lastError: state.lastError ? { message: state.lastError.message, at: state.lastError.at } : null,
			consecutiveFailures: state.consecutiveFailures,
		}
	}

	sensordata(id) {
		return this.state(id).sensordata
	}

	findServer(id) {
		return this.getServers().find((server) => server.id === id)
	}

	// Polls, mode changes and releases for one server run strictly one after another
	enqueue(id, task) {
		const next = (this.queues.get(id) || Promise.resolve()).catch(() => {}).then(task)
		this.queues.set(id, next)
		next.finally(() => {
			if (this.queues.get(id) === next) this.queues.delete(id)
		}).catch(() => {})
		return next
	}

	poll(id) {
		return this.enqueue(id, () => this.pollServer(id))
	}

	start() {
		const loop = async () => {
			const started = this.now()
			try {
				await this.runCycle()
			} catch (error) {
				this.log.error(`Control loop error: ${error.stack || error}`)
			}
			if (this.stopping) return
			this.timer = setTimeout(loop, Math.max(1000, this.pollIntervalMs - (this.now() - started)))
		}
		loop()
	}

	async runCycle() {
		const started = this.now()
		for (const server of [...this.getServers()]) {
			if (this.stopping) break
			try {
				await this.poll(server.id)
			} catch (error) {
				this.log.error(`[${server.name}] Poll failed: ${error.stack || error}`)
			}
		}
		this.lastCycleAt = this.now()
		this.lastCycleDurationMs = this.lastCycleAt - started
		this.onCycle(this.lastCycleDurationMs)
	}

	async pollServer(id) {
		const server = this.findServer(id)
		if (!server || this.stopping) return
		const state = this.state(id)
		state.cycleFailed = false

		try {
			const rows = parseSensorOutput(await this.ipmi.getSensors(server))
			if (!rows.length) throw new Error("ipmitool returned no sensor readings")
			state.sensordata = toSensorData(rows, state.sensordata)
			state.lastUpdate = this.now()
			const hottest = getHottestSensor(state.sensordata)
			state.highestTemperature = hottest ? Number(hottest.value) : null
			state.hottestSensor = hottest?.name ?? null
		} catch (error) {
			this.fail(server, state, "sensor", error)
		}

		if (!state.cycleFailed) {
			try {
				if (server.manualFanControl) await this.controlManually(server, state)
				else await this.handToIdrac(server, state)
			} catch (error) {
				state.mode = "unknown"
				this.fail(server, state, error.operation || "control", error)
			}
		}

		if (state.cycleFailed && server.manualFanControl && state.consecutiveFailures >= this.failsafeReadFailures) {
			const reason = `${state.consecutiveFailures} polls in a row failed (${state.lastError.message})`
			await this.failsafe(server, state, "failures", reason, { quiet: state.failsafeKind === "failures" })
		}
		if (!state.cycleFailed) state.consecutiveFailures = 0
		this.publish(server, state)
	}

	async handToIdrac(server, state) {
		state.failsafeKind = null
		state.failsafeReason = null
		state.targetFanSpeed = null
		state.controlTemperature = null
		if (state.appliedMode !== "automatic") {
			if (this.stopping) return
			await this.ipmi.enableAutomaticFancontrol(server)
			state.appliedMode = "automatic"
			this.log.log(`[${server.name}] Fan control handed to the iDRAC (automatic)`)
		}
		state.mode = "automatic"
	}

	async controlManually(server, state) {
		if (!getTemperatureSensors(state.sensordata).length) {
			return this.failsafe(server, state, "no_temperature", "the iDRAC reported no temperature readings")
		}
		const overheated = findOverheatedSensor(state.sensordata, server.failsafeTemperature)
		if (overheated) return this.failsafe(server, state, "overheat", describeOverheat(overheated))
		// After an overheat, leave the iDRAC in charge until everything is comfortably below its limit
		if (state.failsafeKind === "overheat" && findOverheatedSensor(state.sensordata, server.failsafeTemperature, FAILSAFE_RECOVERY_MARGIN)) {
			return this.failsafe(server, state, "overheat", state.failsafeReason)
		}

		const result = calculateManualFanSpeed(
			{ ...server, sensordata: state.sensordata },
			{ previousControlTemperature: state.mode === "manual" ? state.controlTemperature : null }
		)
		if (this.stopping) return
		// Sent every poll, not just at startup: the iDRAC reverts to automatic whenever it restarts or the host
		// loses power, and silently ignores speed commands until manual mode is re-enabled. Harmless when already manual.
		await this.ipmi.enableManualFancontrol(server)
		state.appliedMode = "manual"
		if (this.stopping) return
		await this.ipmi.setFanSpeed(server, result.targetFanSpeed)

		if (state.failsafeKind) this.log.log(`[${server.name}] Failsafe cleared; the app is controlling the fans again`)
		state.failsafeKind = null
		state.failsafeReason = null
		state.mode = "manual"
		state.targetFanSpeed = result.targetFanSpeed
		state.controlTemperature = result.controlTemperature

		const now = this.now()
		if (state.lastSpeedLog.speed !== result.targetFanSpeed || now - state.lastSpeedLog.at >= SUMMARY_INTERVAL_MS) {
			const reason = result.reason ? ` (${result.reason})` : ""
			const dryRun = this.ipmi.dryRun ? " [dry run]" : ""
			this.log.log(`[${server.name}] ${result.hottestSensor ?? "Highest temperature"} ${result.highestTemperature} °C → fan ${result.targetFanSpeed} %${reason}${dryRun}`)
			state.lastSpeedLog = { at: now, speed: result.targetFanSpeed }
		}
	}

	async failsafe(server, state, kind, reason, { quiet = false } = {}) {
		if (!quiet && state.failsafeReason !== reason) this.log.warn(`[${server.name}] FAILSAFE: ${reason}. Handing fan control back to the iDRAC.`)
		state.failsafeKind = kind
		state.failsafeReason = reason
		state.mode = "failsafe"
		state.targetFanSpeed = null
		if (state.appliedMode === "automatic" || this.stopping) return
		try {
			await this.ipmi.enableAutomaticFancontrol(server)
			state.appliedMode = "automatic"
		} catch (error) {
			this.fail(server, state, "automatic", error)
		}
	}

	fail(server, state, operation, error) {
		const message = redact(error?.message || String(error), [server.password])
		const now = this.now()
		state.lastError = { message, at: now, operation }
		if (!state.cycleFailed) {
			state.cycleFailed = true
			state.consecutiveFailures += 1
		}
		try {
			this.onError(server, operation, error)
		} catch (callbackError) {
			this.log.error(`onError callback failed: ${callbackError.message}`)
		}
		if (state.lastErrorLog.message !== message || now - state.lastErrorLog.at >= SUMMARY_INTERVAL_MS) {
			this.log.error(`[${server.name}] ${message}`)
			state.lastErrorLog = { at: now, message }
		}
	}

	publish(server, state) {
		try {
			this.onPoll(server, state)
		} catch (error) {
			this.log.error(`onPoll callback failed: ${error.stack || error}`)
		}
	}

	// Give fan control back to the iDRAC, e.g. before deleting a server or changing its connection details
	async release(server, { timeout } = {}) {
		const state = this.state(server.id)
		if (!server.manualFanControl && state.appliedMode !== "manual") return false
		await this.ipmi.enableAutomaticFancontrol(server, timeout ? { timeout } : undefined)
		state.appliedMode = "automatic"
		this.log.log(`[${server.name}] Fan control handed back to the iDRAC`)
		return true
	}

	resetConnection(id) {
		const state = this.state(id)
		state.appliedMode = null
		state.mode = "unknown"
		state.sensordata = []
		state.consecutiveFailures = 0
		state.failsafeKind = null
		state.failsafeReason = null
	}

	forget(id) {
		this.states.delete(id)
	}

	health() {
		const now = this.now()
		const staleAfterMs = Math.max(5 * 60 * 1000, 5 * this.pollIntervalMs)
		const problems = []
		const lastCycle = this.lastCycleAt ?? this.startedAt
		if (now - lastCycle > staleAfterMs) problems.push(`Control loop has not completed a cycle for ${Math.round((now - lastCycle) / 1000)} s`)
		const servers = this.getServers().map((server) => {
			const state = this.state(server.id)
			const since = state.lastUpdate ?? this.startedAt
			if (now - since > staleAfterMs) problems.push(`${server.name}: no sensor reading for ${Math.round((now - since) / 1000)} s`)
			if (state.mode === "failsafe") problems.push(`${server.name}: failsafe, ${state.failsafeReason}`)
			return { id: server.id, name: server.name, mode: state.mode, lastUpdate: state.lastUpdate, consecutiveFailures: state.consecutiveFailures }
		})
		return { ok: problems.length === 0, problems, servers, lastCycleAt: this.lastCycleAt, dryRun: Boolean(this.ipmi.dryRun) }
	}

	// Stop polling and hand every app-controlled server back to the iDRAC, so the fans are never left
	// pinned at a fixed speed with nothing watching the temperatures
	async shutdown({ restoreAuto = true, waitMs = 10000, timeout = 8000 } = {}) {
		this.stopping = true
		clearTimeout(this.timer)
		await Promise.race([Promise.allSettled([...this.queues.values()]), sleep(waitMs)])
		if (!restoreAuto) return []
		const servers = this.getServers().filter((server) => server.manualFanControl || this.state(server.id).appliedMode === "manual")
		const results = await Promise.allSettled(servers.map((server) => this.ipmi.enableAutomaticFancontrol(server, { timeout })))
		results.forEach((result, i) => {
			const server = servers[i]
			if (result.status === "fulfilled") {
				this.state(server.id).appliedMode = "automatic"
				this.log.log(`[${server.name}] Fan control handed back to the iDRAC`)
			} else {
				this.log.error(`[${server.name}] Could not hand fan control back to the iDRAC: ${redact(result.reason?.message, [server.password])}`)
			}
		})
		return results
	}
}

module.exports = {
	FanController,
	SUMMARY_INTERVAL_MS,
}
