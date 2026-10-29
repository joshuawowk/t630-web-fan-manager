const promclient = require("prom-client")
const units = require("./units")

const MODES = ["manual", "automatic", "failsafe", "unknown"]

function createMetrics(register = promclient.register) {
	promclient.collectDefaultMetrics({ register, labels: { application: "serverManager" } })
	const registers = [register]
	const sensorGauge = new promclient.Gauge({
		name: "servermanager_statistics_gauge",
		help: "Contains all gauge statistics from the dell server manager labeled by name and type, ex fan speed or temperature",
		labelNames: ["name", "type", "unit", "address", "host_name"],
		registers,
	})
	const fanTarget = new promclient.Gauge({
		name: "servermanager_fan_target_percent",
		help: "Fan speed last sent to the iDRAC, in percent",
		labelNames: ["address", "host_name"],
		registers,
	})
	const controlTemperature = new promclient.Gauge({
		name: "servermanager_control_temperature_celsius",
		help: "Temperature used for the fan curve lookup",
		labelNames: ["address", "host_name"],
		registers,
	})
	const controlMode = new promclient.Gauge({
		name: "servermanager_fan_control_mode",
		help: "1 for the current fan control mode (manual, automatic, failsafe, unknown)",
		labelNames: ["address", "host_name", "mode"],
		registers,
	})
	const lastRead = new promclient.Gauge({
		name: "servermanager_last_sensor_read_timestamp_seconds",
		help: "Unix time of the last successful sensor read",
		labelNames: ["address", "host_name"],
		registers,
	})
	const ipmiErrors = new promclient.Counter({
		name: "servermanager_ipmi_errors_total",
		help: "Failed IPMI operations",
		labelNames: ["address", "host_name", "operation"],
		registers,
	})
	const cycleDuration = new promclient.Gauge({
		name: "servermanager_cycle_duration_seconds",
		help: "Duration of the last poll cycle over all servers",
		registers,
	})

	const sensorLabels = new Map()

	function forget(id) {
		for (const labels of sensorLabels.get(id) || []) sensorGauge.remove(labels)
		sensorLabels.delete(id)
	}

	return {
		register,
		recordPoll(server, state) {
			const host = { address: server.address, host_name: server.name }
			// Drop series from the previous poll first so renamed servers or vanished sensors don't linger
			forget(server.id)
			const current = []
			for (const sensor of state.sensordata) {
				if (typeof sensor.value !== "number") continue
				const labels = { name: sensor.name, type: units.unit_to_type[sensor.unit], unit: sensor.unit, ...host }
				sensorGauge.set(labels, sensor.value)
				current.push(labels)
			}
			sensorLabels.set(server.id, current)
			fanTarget.remove(host)
			if (typeof state.targetFanSpeed === "number") fanTarget.set(host, state.targetFanSpeed)
			controlTemperature.remove(host)
			if (typeof state.controlTemperature === "number") controlTemperature.set(host, state.controlTemperature)
			for (const mode of MODES) controlMode.set({ ...host, mode }, state.mode === mode ? 1 : 0)
			if (state.lastUpdate) lastRead.set(host, state.lastUpdate / 1000)
		},
		recordError(server, operation) {
			ipmiErrors.inc({ address: server.address, host_name: server.name, operation })
		},
		recordCycle(durationMs) {
			cycleDuration.set(durationMs / 1000)
		},
		forgetServer(server) {
			forget(server.id)
			const host = { address: server.address, host_name: server.name }
			fanTarget.remove(host)
			controlTemperature.remove(host)
			lastRead.remove(host)
			for (const mode of MODES) controlMode.remove({ ...host, mode })
		},
	}
}

module.exports = { createMetrics }
