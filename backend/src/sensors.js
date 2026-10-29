// Columns of `ipmitool sensor` after name, value, unit and status
const THRESHOLD_FIELDS = ["lowerNonRecoverable", "lowerCritical", "lowerNonCritical", "upperNonCritical", "upperCritical", "upperNonRecoverable"]

function parseNumber(text) {
	return /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : null
}

function round(value) {
	return Math.round(value * 1000) / 1000
}

function parseSensorOutput(text) {
	const seen = new Map()
	return String(text ?? "")
		.split("\n")
		.map((line) => line.split("|").map((column) => column.trim()))
		.filter((columns) => columns.length >= 4 && columns[0])
		.map((columns) => {
			// Dell reports both CPU temperatures as "Temp"; number repeats so they don't overwrite each other
			const count = (seen.get(columns[0]) || 0) + 1
			seen.set(columns[0], count)
			return [count === 1 ? columns[0] : `${columns[0]} #${count}`, ...columns.slice(1)]
		})
		.filter((columns) => columns[1] && columns[1] !== "na")
}

function toSensorData(rows, previous = []) {
	const previousByName = new Map(previous.map((sensor) => [sensor.name, sensor]))
	return rows.map((columns) => {
		const value = parseNumber(columns[1]) ?? columns[1]
		const previousValue = previousByName.get(columns[0])?.value ?? null
		const sensor = {
			name: columns[0],
			value,
			unit: columns[2] || "",
			status: columns[3] || "",
		}
		THRESHOLD_FIELDS.forEach((field, i) => {
			sensor[field] = parseNumber(columns[4 + i] ?? "na")
		})
		sensor.previousValue = previousValue
		sensor.trend = typeof value === "number" && typeof previousValue === "number" ? round(value - previousValue) : 0
		return sensor
	})
}

module.exports = {
	THRESHOLD_FIELDS,
	parseSensorOutput,
	toSensorData,
}
