const DEFAULT_FAN_SPEED = 40
// After an overheat failsafe, the app takes the fans back once every sensor is this far below its limit
const FAILSAFE_RECOVERY_MARGIN = 5

function normalizeFanCurve(fancurve) {
	if (!Array.isArray(fancurve)) return null
	const normalized = fancurve
		.map((value) => {
			if (value === null || value === "" || typeof value === "boolean") return null
			const numeric = Number(value)
			return Number.isFinite(numeric) ? Math.max(0, Math.min(100, numeric)) : null
		})
		.filter((value) => value !== null)
	if (normalized.length < 2) return null
	return normalized
}

// Curve points are evenly spaced from 0 °C (first point) to 100 °C (last point), as the editor draws them
function interpolateFanCurve(fancurve, temperature) {
	const segments = fancurve.length - 1
	const position = (Math.max(0, Math.min(100, temperature)) / 100) * segments
	const lowerIndex = Math.floor(position)
	const upperIndex = Math.min(segments, lowerIndex + 1)
	const fraction = position - lowerIndex
	return fancurve[lowerIndex] + (fancurve[upperIndex] - fancurve[lowerIndex]) * fraction
}

function getTemperatureSensors(sensordata = []) {
	return sensordata.filter((sensor) => sensor && sensor.unit === "degrees C" && Number.isFinite(Number(sensor.value)) && sensor.value !== "")
}

function getHottestSensor(sensordata = []) {
	let hottest = null
	for (const sensor of getTemperatureSensors(sensordata)) {
		if (!hottest || Number(sensor.value) > Number(hottest.value)) hottest = sensor
	}
	return hottest
}

function getHighestTemperature(sensordata = []) {
	const hottest = getHottestSensor(sensordata)
	return hottest ? Number(hottest.value) : null
}

// Only let the control temperature fall once it has dropped by the hysteresis, so fans don't hunt
function applyHysteresis(previousControlTemperature, temperature, hysteresis) {
	if (!Number.isFinite(previousControlTemperature) || !(hysteresis > 0)) return temperature
	if (temperature >= previousControlTemperature) return temperature
	if (previousControlTemperature - temperature >= hysteresis) return temperature
	return previousControlTemperature
}

function temperatureLimit(sensor, failsafeTemperature) {
	const limits = [sensor.upperNonCritical, failsafeTemperature].filter((limit) => typeof limit === "number" && Number.isFinite(limit))
	return limits.length ? Math.min(...limits) : null
}

// A temperature at or above its limit (the sensor's own upper non-critical threshold, or the configured
// failsafe temperature if lower), or one the iDRAC itself flags critical, means the iDRAC should take over
function findOverheatedSensor(sensordata, failsafeTemperature = null, margin = 0) {
	for (const sensor of getTemperatureSensors(sensordata)) {
		const value = Number(sensor.value)
		if (["cr", "nr"].includes(sensor.status)) return { sensor, value, limit: null }
		const limit = temperatureLimit(sensor, failsafeTemperature)
		if (limit !== null && value >= limit - margin) return { sensor, value, limit }
	}
	return null
}

function calculateManualFanSpeed(config = {}, { previousControlTemperature = null } = {}) {
	const hottest = getHottestSensor(config.sensordata)
	const highestTemperature = hottest ? Number(hottest.value) : null
	const fallbackSpeed = Number.isFinite(config.defaultFanSpeed) ? config.defaultFanSpeed : DEFAULT_FAN_SPEED
	const fanCurve = normalizeFanCurve(config.fancurve)
	if (!fanCurve) {
		return {
			targetFanSpeed: fallbackSpeed,
			highestTemperature,
			controlTemperature: highestTemperature,
			hottestSensor: hottest?.name ?? null,
			reason: "missing_fancurve",
		}
	}
	if (!Number.isFinite(highestTemperature)) {
		return {
			targetFanSpeed: fallbackSpeed,
			highestTemperature,
			controlTemperature: null,
			hottestSensor: null,
			reason: "missing_temperature",
		}
	}
	const controlTemperature = applyHysteresis(previousControlTemperature, highestTemperature, Number(config.hysteresis) || 0)
	const target = Math.round(interpolateFanCurve(fanCurve, controlTemperature))
	return {
		targetFanSpeed: Number.isFinite(target) ? target : fallbackSpeed,
		highestTemperature,
		controlTemperature,
		hottestSensor: hottest.name,
		curveSize: fanCurve.length,
	}
}

module.exports = {
	DEFAULT_FAN_SPEED,
	FAILSAFE_RECOVERY_MARGIN,
	applyHysteresis,
	calculateManualFanSpeed,
	findOverheatedSensor,
	getHighestTemperature,
	getHottestSensor,
	getTemperatureSensors,
	interpolateFanCurve,
	normalizeFanCurve,
}
