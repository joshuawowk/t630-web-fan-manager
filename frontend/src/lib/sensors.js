export const ALERT_COLOR = "#cf1322"

const isNumber = (x) => typeof x === "number" && Number.isFinite(x)

// A reading is an alert when the sensor reports a non-ok status, crosses a non-critical threshold, or (fans) exceeds the server's warnspeed.
// Null thresholds never trigger an alert.
export function isAlertReading(sensor, warnspeed) {
	if (!sensor) return false
	const { value, status, unit, upperNonCritical, lowerNonCritical } = sensor
	if (status && String(status).toLowerCase() !== "ok") return true
	if (!isNumber(value)) return false
	if (isNumber(upperNonCritical) && value >= upperNonCritical) return true
	if (isNumber(lowerNonCritical) && value <= lowerNonCritical) return true
	if (unit === "RPM" && isNumber(warnspeed) && value > warnspeed) return true
	return false
}

export function sensorColor(sensor, warnspeed) {
	return isAlertReading(sensor, warnspeed) ? ALERT_COLOR : undefined
}
