const fs = require("fs")
const path = require("path")

const FIXTURE = fs.readFileSync(path.join(__dirname, "fixtures", "t630-sensor.txt"), "utf8")
const MOCK_IPMITOOL = path.join(__dirname, "mock-ipmitool.js")

// Rewrite the value (and optionally status) of the nth sensor row called `name` in `ipmitool sensor` output
function setReading(text, name, value, { occurrence = 1, status } = {}) {
	let seen = 0
	return text
		.split("\n")
		.map((line) => {
			const columns = line.split("|")
			if (columns[0].trim() !== name || ++seen !== occurrence) return line
			columns[1] = ` ${Number(value).toFixed(3)}`.padEnd(columns[1].length)
			if (status) columns[3] = ` ${status}`.padEnd(columns[3].length)
			return columns.join("|")
		})
		.join("\n")
}

function withCpuTemps(cpu1, cpu2 = cpu1, options = {}) {
	return setReading(setReading(FIXTURE, "Temp", cpu1, { ...options, occurrence: 1 }), "Temp", cpu2, { occurrence: 2 })
}

// In-memory IPMI double for controller tests
function fakeIpmi(sensorText = FIXTURE) {
	const calls = []
	const fake = {
		calls,
		dryRun: false,
		sensorText,
		failReads: false,
		failWrites: false,
		async getSensors() {
			calls.push(["sensor"])
			if (fake.failReads) throw new Error("ipmitool sensor failed (timed out after 20s)")
			return fake.sensorText
		},
		async enableManualFancontrol() {
			if (fake.failWrites) throw Object.assign(new Error("ipmitool raw failed"), { operation: "manual" })
			calls.push(["manual"])
		},
		async enableAutomaticFancontrol() {
			if (fake.failWrites) throw Object.assign(new Error("ipmitool raw failed"), { operation: "automatic" })
			calls.push(["automatic"])
		},
		async setFanSpeed(config, speed) {
			if (fake.failWrites) throw Object.assign(new Error("ipmitool raw failed"), { operation: "speed" })
			calls.push(["speed", speed])
		},
		commands() {
			return calls.filter((call) => call[0] !== "sensor")
		},
		reset() {
			calls.length = 0
		},
	}
	return fake
}

const quietLog = { log() {}, warn() {}, error() {} }

const USER_CURVE = [10, 10, 10, 12, 14, 16, 18, 21, 26, 31, 38, 45, 60, 75, 85, 95, 100]

module.exports = {
	FIXTURE,
	MOCK_IPMITOOL,
	USER_CURVE,
	fakeIpmi,
	quietLog,
	setReading,
	withCpuTemps,
}
