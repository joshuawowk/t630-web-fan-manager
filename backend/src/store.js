const fs = require("fs")
const path = require("path")
const crypto = require("crypto")
const { normalizeFanCurve } = require("./fanControl")

const FILE = "servers.json"
const CONNECTION_FIELDS = ["address", "username", "password"]
// Used for newly added servers: quiet at idle, 100 % by 90 °C
const DEFAULT_FAN_CURVE = [10, 10, 10, 15, 20, 30, 45, 60, 80, 100, 100]
const EDITABLE_FIELDS = ["name", ...CONNECTION_FIELDS, "warnspeed", "manualFanControl", "fancurve", "hysteresis", "failsafeTemperature"]

class ValidationError extends Error {}

function newId() {
	return crypto.randomBytes(4).toString("hex")
}

function toNumber(value, field, { min, max, allowNull = false }) {
	if (allowNull && (value === null || value === undefined || value === "")) return null
	const numeric = typeof value === "string" && value.trim() !== "" ? Number(value) : value
	if (typeof numeric !== "number" || !Number.isFinite(numeric)) throw new ValidationError(`${field} must be a number`)
	if (numeric < min || numeric > max) throw new ValidationError(`${field} must be between ${min} and ${max}`)
	return numeric
}

function toText(value, field, { max, pattern, message }) {
	if (typeof value !== "string" || !value.trim()) throw new ValidationError(`${field} is required`)
	const text = value.trim()
	if (text.length > max) throw new ValidationError(`${field} is too long`)
	if (pattern && !pattern.test(text)) throw new ValidationError(message || `${field} is invalid`)
	return text
}

// Returns only the editable fields present in `input`, validated. An empty password means "keep the current one".
function sanitize(input) {
	if (!input || typeof input !== "object") throw new ValidationError("Expected an object")
	const clean = {}
	for (const field of EDITABLE_FIELDS) {
		if (!(field in input) || input[field] === undefined) continue
		const value = input[field]
		switch (field) {
			case "name":
				clean.name = toText(value, "Name", { max: 100 })
				break
			case "address":
				clean.address = toText(value, "Address", {
					max: 253,
					pattern: /^[A-Za-z0-9[][A-Za-z0-9.:_%[\]-]*$/,
					message: "Address must be an IP address or hostname",
				})
				break
			case "username":
				clean.username = toText(value, "Username", { max: 64 })
				break
			case "password":
				if (value === "" || value === null) break
				if (typeof value !== "string" || value.length > 128) throw new ValidationError("Password must be a string of at most 128 characters")
				clean.password = value
				break
			case "warnspeed":
				clean.warnspeed = toNumber(value, "Warning speed", { min: 0, max: 50000 })
				break
			case "manualFanControl":
				if (typeof value !== "boolean") throw new ValidationError("Custom fan control must be true or false")
				clean.manualFanControl = value
				break
			case "fancurve": {
				if (!Array.isArray(value) || value.length > 101) throw new ValidationError("Fan curve must be a list of at most 101 points")
				const curve = normalizeFanCurve(value)
				if (!curve || curve.length !== value.length) throw new ValidationError("Fan curve needs at least 2 points, each between 0 and 100 %")
				clean.fancurve = curve
				break
			}
			case "hysteresis":
				clean.hysteresis = toNumber(value, "Hysteresis", { min: 0, max: 20 })
				break
			case "failsafeTemperature":
				clean.failsafeTemperature = toNumber(value, "Failsafe temperature", { min: 30, max: 110, allowNull: true })
				break
		}
	}
	return clean
}

// Bring a server loaded from disk (possibly written by the 2022 image) to the current shape
function normalizeStored(raw) {
	return {
		id: typeof raw.id === "string" && raw.id ? raw.id : newId(),
		name: String(raw.name ?? raw.address ?? "Server"),
		address: String(raw.address ?? ""),
		username: String(raw.username ?? ""),
		password: String(raw.password ?? ""),
		warnspeed: Number.isFinite(Number(raw.warnspeed)) && raw.warnspeed !== "" ? Number(raw.warnspeed) : 3000,
		manualFanControl: raw.manualFanControl === true,
		fancurve: normalizeFanCurve(raw.fancurve),
		hysteresis: Number.isFinite(Number(raw.hysteresis)) ? Math.max(0, Math.min(20, Number(raw.hysteresis))) : 0,
		failsafeTemperature: typeof raw.failsafeTemperature === "number" && Number.isFinite(raw.failsafeTemperature) ? raw.failsafeTemperature : null,
	}
}

function createStore({ dataDir, log = console }) {
	const file = path.join(dataDir, FILE)
	let servers = []
	let onDisk = null
	let saveTimer = null

	function load() {
		fs.mkdirSync(dataDir, { recursive: true })
		let text
		try {
			text = fs.readFileSync(file, "utf8")
		} catch (error) {
			if (error.code !== "ENOENT") throw error
			servers = []
			return servers
		}
		const parsed = JSON.parse(text)
		if (!Array.isArray(parsed)) throw new Error(`${file} does not contain a list of servers`)
		const legacy = parsed.some((server) => !server.id || "sensordataRaw" in server)
		if (legacy) {
			const backup = `${file}.v1.bak`
			if (!fs.existsSync(backup)) {
				fs.copyFileSync(file, backup)
				fs.chmodSync(backup, 0o600)
				log.log(`Backed up the original ${FILE} to ${backup}`)
			}
		}
		servers = parsed.map(normalizeStored)
		log.log(`Loaded ${servers.length} server(s) from ${file}`)
		save()
		return servers
	}

	function serialize() {
		// Empty sensordata keeps the file loadable by the 2022 image, so rolling back does not crash it
		return JSON.stringify(
			servers.map((server) => ({ ...server, sensordata: [], sensordataRaw: [] })),
			null,
			4
		)
	}

	function save() {
		clearTimeout(saveTimer)
		saveTimer = null
		const text = serialize()
		if (text === onDisk) return
		const tmp = `${file}.tmp`
		fs.writeFileSync(tmp, text, { mode: 0o600 })
		fs.chmodSync(tmp, 0o600)
		fs.renameSync(tmp, file)
		onDisk = text
	}

	function scheduleSave() {
		if (saveTimer) return
		saveTimer = setTimeout(() => {
			try {
				save()
			} catch (error) {
				log.error(`Failed to save ${file}: ${error.message}`)
			}
		}, 500)
	}

	return {
		file,
		load,
		save,
		scheduleSave,
		get servers() {
			return servers
		},
		find(id) {
			return servers.find((server) => server.id === id)
		},
		add(input) {
			const clean = sanitize(input)
			for (const field of ["name", "address", "username", "password"]) {
				if (clean[field] === undefined) throw new ValidationError(`${field[0].toUpperCase() + field.slice(1)} is required`)
			}
			if (servers.some((server) => server.name === clean.name)) throw new ValidationError(`A server named "${clean.name}" already exists`)
			if (servers.some((server) => server.address === clean.address)) throw new ValidationError(`A server with address ${clean.address} already exists`)
			const server = normalizeStored({ fancurve: DEFAULT_FAN_CURVE, ...clean, id: newId() })
			servers.push(server)
			scheduleSave()
			return server
		},
		update(id, input) {
			const server = servers.find((candidate) => candidate.id === id)
			if (!server) throw new ValidationError("Server not found")
			const clean = sanitize(input)
			if (clean.name !== undefined && servers.some((other) => other !== server && other.name === clean.name)) {
				throw new ValidationError(`A server named "${clean.name}" already exists`)
			}
			if (clean.address !== undefined && servers.some((other) => other !== server && other.address === clean.address)) {
				throw new ValidationError(`A server with address ${clean.address} already exists`)
			}
			const previous = { ...server }
			Object.assign(server, clean)
			scheduleSave()
			return { server, previous, connectionChanged: CONNECTION_FIELDS.some((field) => previous[field] !== server[field]) }
		},
		remove(id) {
			const index = servers.findIndex((server) => server.id === id)
			if (index === -1) throw new ValidationError("Server not found")
			const [server] = servers.splice(index, 1)
			scheduleSave()
			return server
		},
	}
}

module.exports = {
	DEFAULT_FAN_CURVE,
	EDITABLE_FIELDS,
	ValidationError,
	createStore,
	normalizeStored,
	sanitize,
}
