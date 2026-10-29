import { ALERT_COLOR, isAlertReading, sensorColor } from "./sensors"

const base = { name: "Temp", value: 40, unit: "degrees C", status: "ok", lowerNonCritical: 8, upperNonCritical: 90 }

describe("sensorColor", () => {
	it("has no colour for a healthy reading", () => {
		expect(sensorColor(base)).toBeUndefined()
	})
	it("is red when the status is not ok", () => {
		expect(sensorColor({ ...base, status: "nc" })).toBe(ALERT_COLOR)
		expect(sensorColor({ ...base, status: "cr" })).toBe("#cf1322")
	})
	it("ignores a missing status", () => {
		expect(sensorColor({ ...base, status: undefined })).toBeUndefined()
	})
	it("is red at or above the upper non-critical threshold", () => {
		expect(sensorColor({ ...base, value: 89 })).toBeUndefined()
		expect(sensorColor({ ...base, value: 90 })).toBe(ALERT_COLOR)
		expect(sensorColor({ ...base, value: 95 })).toBe(ALERT_COLOR)
	})
	it("is red at or below the lower non-critical threshold", () => {
		expect(sensorColor({ ...base, value: 9 })).toBeUndefined()
		expect(sensorColor({ ...base, value: 8 })).toBe(ALERT_COLOR)
	})
	it("never turns red because of null thresholds", () => {
		expect(isAlertReading({ ...base, value: 500, lowerNonCritical: null, upperNonCritical: null })).toBe(false)
		expect(isAlertReading({ ...base, value: 0, lowerNonCritical: null, upperNonCritical: null })).toBe(false)
	})
	it("handles zero thresholds as numbers", () => {
		expect(isAlertReading({ ...base, value: 0, lowerNonCritical: 0, upperNonCritical: null })).toBe(true)
	})
	it("compares fans against warnspeed only for RPM", () => {
		const fan = { name: "Fan1", value: 6000, unit: "RPM", status: "ok", lowerNonCritical: null, upperNonCritical: null }
		expect(sensorColor(fan, 5000)).toBe(ALERT_COLOR)
		expect(sensorColor({ ...fan, value: 5000 }, 5000)).toBeUndefined()
		expect(sensorColor(fan, null)).toBeUndefined()
		expect(sensorColor(fan, undefined)).toBeUndefined()
		expect(sensorColor({ ...fan, unit: "Watts" }, 5000)).toBeUndefined()
	})
	it("does not compare discrete string values against thresholds", () => {
		expect(isAlertReading({ name: "PS", value: "0x1", unit: "discrete", status: "ok", upperNonCritical: 0, lowerNonCritical: 5 })).toBe(false)
	})
})
