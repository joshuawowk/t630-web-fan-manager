import { describe, it, expect } from "vitest"
import { applyHysteresis, calculateManualFanSpeed, DEFAULT_FAN_SPEED, findOverheatedSensor, getHighestTemperature, interpolateFanCurve, normalizeFanCurve } from "../src/fanControl"
import { USER_CURVE } from "./helpers"

const temp = (value, extra = {}) => ({ name: "Temp", unit: "degrees C", value, status: "ok", upperNonCritical: 90, ...extra })

describe("calculateManualFanSpeed", () => {
	it("falls back to default speed when fan curve is missing", () => {
		const result = calculateManualFanSpeed({
			manualFanControl: true,
			sensordata: [{ unit: "degrees C", value: 45 }],
		})

		expect(result).toEqual(
			expect.objectContaining({
				targetFanSpeed: DEFAULT_FAN_SPEED,
				reason: "missing_fancurve",
			})
		)
	})

	it("follows the curve as drawn: straight lines between evenly spaced points", () => {
		const curve = [0, 100]
		expect(calculateManualFanSpeed({ fancurve: curve, sensordata: [temp(25)] }).targetFanSpeed).toBe(25)
		expect(calculateManualFanSpeed({ fancurve: curve, sensordata: [temp(100)] }).targetFanSpeed).toBe(100)
		expect(calculateManualFanSpeed({ fancurve: curve, sensordata: [temp(0)] }).targetFanSpeed).toBe(0)
	})

	it("uses the hottest temperature sensor", () => {
		const result = calculateManualFanSpeed({ fancurve: [0, 100], sensordata: [temp(20, { name: "Inlet Temp" }), temp(60), temp(40, { name: "Temp #2" })] })
		expect(result).toMatchObject({ highestTemperature: 60, hottestSensor: "Temp", targetFanSpeed: 60 })
	})

	it("gives the T630 curve its expected speeds", () => {
		const speed = (t) => calculateManualFanSpeed({ fancurve: USER_CURVE, sensordata: [temp(t)] }).targetFanSpeed
		// 17 points are 6.25 °C apart: 34 °C sits 44% of the way from 16 % (31.25 °C) to 18 % (37.5 °C)
		expect(speed(34)).toBe(17)
		expect(speed(37.5)).toBe(18)
		// The 2022 image multiplied the in-segment slope by 20 and asked for ~34 % here
		expect(speed(49)).toBe(25)
		expect(speed(100)).toBe(100)
	})

	it("ignores non-temperature sensors and unparseable values", () => {
		expect(getHighestTemperature([{ unit: "RPM", value: 9000 }, temp("na"), temp(30)])).toBe(30)
		expect(calculateManualFanSpeed({ fancurve: [10, 20], sensordata: [{ unit: "RPM", value: 1 }] }).reason).toBe("missing_temperature")
	})

	it("holds the control temperature until it falls by the hysteresis", () => {
		const config = { fancurve: [0, 100], hysteresis: 3, sensordata: [temp(48)] }
		expect(calculateManualFanSpeed(config, { previousControlTemperature: 50 })).toMatchObject({ controlTemperature: 50, targetFanSpeed: 50 })
		config.sensordata = [temp(47)]
		expect(calculateManualFanSpeed(config, { previousControlTemperature: 50 })).toMatchObject({ controlTemperature: 47, targetFanSpeed: 47 })
		config.sensordata = [temp(55)]
		expect(calculateManualFanSpeed(config, { previousControlTemperature: 50 })).toMatchObject({ controlTemperature: 55 })
	})
})

describe("interpolateFanCurve", () => {
	it("clamps temperatures outside 0-100 °C", () => {
		expect(interpolateFanCurve([20, 80], -10)).toBe(20)
		expect(interpolateFanCurve([20, 80], 150)).toBe(80)
	})
})

describe("applyHysteresis", () => {
	it("passes the temperature through when disabled or rising", () => {
		expect(applyHysteresis(null, 40, 5)).toBe(40)
		expect(applyHysteresis(50, 45, 0)).toBe(45)
		expect(applyHysteresis(40, 45, 5)).toBe(45)
	})
})

describe("normalizeFanCurve", () => {
	it("clamps points and rejects curves with fewer than two", () => {
		expect(normalizeFanCurve([-5, 50, 150])).toEqual([0, 50, 100])
		expect(normalizeFanCurve([50])).toBeNull()
		expect(normalizeFanCurve("10,20")).toBeNull()
		expect(normalizeFanCurve([10, null, 20])).toEqual([10, 20])
	})
})

describe("findOverheatedSensor", () => {
	it("trips at the sensor's own upper non-critical threshold", () => {
		expect(findOverheatedSensor([temp(89)])).toBeNull()
		expect(findOverheatedSensor([temp(90)])).toMatchObject({ value: 90, limit: 90 })
	})

	it("uses a configured failsafe temperature only when it is lower", () => {
		expect(findOverheatedSensor([temp(75)], 75)).toMatchObject({ limit: 75 })
		expect(findOverheatedSensor([temp(91)], 100)).toMatchObject({ limit: 90 })
		expect(findOverheatedSensor([temp(60, { upperNonCritical: null })], null)).toBeNull()
	})

	it("trips when the iDRAC flags a temperature critical", () => {
		expect(findOverheatedSensor([temp(50, { status: "cr" })])).toMatchObject({ limit: null })
	})

	it("applies a recovery margin", () => {
		expect(findOverheatedSensor([temp(86)], null, 5)).not.toBeNull()
		expect(findOverheatedSensor([temp(84)], null, 5)).toBeNull()
	})
})
