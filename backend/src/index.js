const http = require("http")
const express = require("express")
const { Server } = require("socket.io")

const settings = require("./config")
const { createIpmi } = require("./ipmi")
const { createStore, ValidationError } = require("./store")
const { FanController } = require("./controller")
const { createMetrics } = require("./metrics")

const store = createStore({ dataDir: settings.dataDir })
store.load()

const ipmi = createIpmi({ ipmitoolPath: settings.ipmitoolPath, timeoutMs: settings.ipmiTimeoutMs, dryRun: settings.dryRun })
const metrics = createMetrics()

const app = express()
const server = http.createServer(app)
const io = new Server(server, { serveClient: false })

const controller = new FanController({
	ipmi,
	getServers: () => store.servers,
	pollIntervalMs: settings.pollIntervalMs,
	failsafeReadFailures: settings.failsafeReadFailures,
	onPoll: (config, state) => {
		metrics.recordPoll(config, state)
		io.emit("sensordata", { id: config.id, name: config.name, sensordata: state.sensordata, status: controller.status(config.id) })
	},
	onError: (config, operation) => metrics.recordError(config, operation),
	onCycle: (durationMs) => metrics.recordCycle(durationMs),
})

function publicView(config) {
	const { password, ...rest } = config
	return { ...rest, hasPassword: Boolean(password), sensordata: controller.sensordata(config.id), status: controller.status(config.id) }
}

function publicServers() {
	return store.servers.map(publicView)
}

function broadcastServers() {
	io.emit("servers", publicServers())
}

// Resolve within `ms` even if the work behind the promise carries on
function within(promise, ms) {
	return Promise.race([promise.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), ms).unref())])
}

app.use("/", express.static(settings.staticDir))
app.get("/info", (req, res) => {
	res.send("Dell server monitor express server")
})
app.get("/api/status", (req, res) => {
	res.json(publicServers())
})
app.get("/healthz", (req, res) => {
	const health = controller.health()
	res.status(health.ok ? 200 : 503).json(health)
})
app.get("/metrics", async (req, res) => {
	res.set("Content-Type", metrics.register.contentType)
	res.send(await metrics.register.metrics())
})

// Every client request is acknowledged with {ok: true, ...} or {ok: false, error}
function handle(socket, event, handler) {
	socket.on(event, async (payload, ack) => {
		const reply = typeof ack === "function" ? ack : () => {}
		try {
			reply({ ok: true, ...((await handler(payload || {})) || {}) })
		} catch (error) {
			if (!(error instanceof ValidationError)) console.error(`${event} failed: ${error.stack || error}`)
			reply({ ok: false, error: error.message })
		}
	})
}

io.on("connection", (socket) => {
	socket.emit("servers", publicServers())
	socket.on("registerWebclient", () => socket.emit("servers", publicServers()))

	handle(socket, "addServer", async ({ server: input }) => {
		const config = store.add(input)
		console.log(`Added server ${config.name} (${config.address})`)
		broadcastServers()
		controller.poll(config.id).catch(() => {})
		return { server: publicView(config) }
	})

	handle(socket, "updateServer", async ({ id, update }) => {
		const existing = store.find(id)
		if (!existing) throw new ValidationError("Server not found")
		const before = { ...existing }
		const { server: config, connectionChanged } = store.update(id, update)
		console.log(
			`Updated server ${config.name}: ${Object.keys(update || {})
				.filter((key) => key !== "password" || update.password)
				.join(", ")}`
		)
		if (connectionChanged) {
			// The old iDRAC may be left in manual mode; hand it back before switching to the new connection
			controller.releaseLater(before).catch((error) => console.error(`[${before.name}] Could not hand fan control back to the iDRAC: ${error.message}`))
			controller.enqueue(id, () => controller.resetConnection(id))
		}
		broadcastServers()
		// Poll right away so a mode change reaches the iDRAC now rather than at the next cycle
		controller.poll(id).catch(() => {})
		return { server: publicView(config) }
	})

	handle(socket, "deleteServer", async ({ id }) => {
		const config = store.find(id)
		if (!config) throw new ValidationError("Server not found")
		store.remove(id)
		broadcastServers()
		const release = controller.releaseLater(config, { timeout: 8000 })
		release
			.catch((error) => console.error(`[${config.name}] Could not hand fan control back to the iDRAC: ${error.message}`))
			.finally(() => {
				controller.forget(id)
				metrics.forgetServer(config)
			})
		console.log(`Deleted server ${config.name} (${config.address})`)
		const handedBack = await within(
			release.catch(() => {}),
			9000
		)
		return { handedBack }
	})
})

let shuttingDown = false
async function shutdown(reason, exitCode) {
	if (shuttingDown) return
	shuttingDown = true
	console.log(`${reason}: stopping${settings.restoreAutoOnExit ? " and handing fan control back to the iDRAC" : ""}`)
	setTimeout(() => process.exit(exitCode), 25000).unref()
	try {
		await controller.shutdown({ restoreAuto: settings.restoreAutoOnExit })
	} catch (error) {
		console.error(`Shutdown error: ${error.stack || error}`)
	}
	try {
		store.save()
	} catch (error) {
		console.error(`Could not save servers: ${error.message}`)
	}
	io.close()
	server.close()
	process.exit(exitCode)
}

process.on("SIGTERM", () => shutdown("SIGTERM", 0))
process.on("SIGINT", () => shutdown("SIGINT", 0))
// A crash must not leave the fans pinned: hand back to the iDRAC, then exit so Docker restarts us
process.on("uncaughtException", (error) => {
	console.error(`Uncaught exception: ${error.stack || error}`)
	shutdown("Crash", 1)
})
process.on("unhandledRejection", (error) => {
	console.error(`Unhandled rejection: ${error?.stack || error}`)
	shutdown("Crash", 1)
})

server.listen(settings.port, () => {
	console.log(`Listening on port ${settings.port}; polling every ${settings.pollIntervalMs / 1000} s${settings.dryRun ? "; DRY RUN, no fan commands are sent" : ""}`)
	controller.start()
})
