import { describe, it, expect } from "vitest"
import { parseSensorOutput, toSensorData } from "../src/sensors"
import { FIXTURE, withCpuTemps } from "./helpers"

describe("parseSensorOutput", () => {
	const sensors = toSensorData(parseSensorOutput(FIXTURE))

	it("keeps both CPU temperatures apart instead of overwriting one with the other", () => {
		const temps = sensors.filter((sensor) => sensor.unit === "degrees C")
		expect(temps.map((sensor) => sensor.name)).toEqual(["Inlet Temp", "Temp", "Temp #2"])
		expect(temps.map((sensor) => sensor.value)).toEqual([17, 34, 33])
	})

	it("parses thresholds, with na as null", () => {
		expect(sensors.find((sensor) => sensor.name === "Temp")).toMatchObject({
			status: "ok",
			lowerNonRecoverable: null,
			lowerCritical: 3,
			lowerNonCritical: 8,
			upperNonCritical: 90,
			upperCritical: 95,
			upperNonRecoverable: null,
		})
	})

	it("omits sensors without a reading and keeps discrete values as text", () => {
		expect(sensors.find((sensor) => sensor.name === "Fan3")).toBeUndefined()
		expect(sensors.filter((sensor) => sensor.unit === "RPM").map((sensor) => sensor.value)).toEqual([1320, 1200])
		const discrete = sensors.find((sensor) => sensor.unit === "discrete")
		expect(typeof discrete.value).toBe("string")
	})

	it("names duplicates by their position among all rows, so a sensor going na does not rename the next", () => {
		const text = FIXTURE.replace(/^(Temp\s+\|)\s*34\.000(\s*)\|/m, (match, head, pad) => `${head} na${" ".repeat(4)}${pad}|`)
		const names = toSensorData(parseSensorOutput(text))
			.filter((sensor) => sensor.unit === "degrees C")
			.map((sensor) => sensor.name)
		expect(names).toEqual(["Inlet Temp", "Temp #2"])
	})

	it("ignores blank lines and garbage", () => {
		expect(parseSensorOutput("\n\nnot a sensor\n | | |\n")).toEqual([])
	})
})

describe("toSensorData", () => {
	it("tracks the previous value and trend by sensor name", () => {
		const first = toSensorData(parseSensorOutput(FIXTURE))
		const second = toSensorData(parseSensorOutput(withCpuTemps(40, 30)), first)
		expect(second.find((sensor) => sensor.name === "Temp")).toMatchObject({ value: 40, previousValue: 34, trend: 6 })
		expect(second.find((sensor) => sensor.name === "Temp #2")).toMatchObject({ value: 30, previousValue: 33, trend: -3 })
		expect(first.find((sensor) => sensor.name === "Temp")).toMatchObject({ previousValue: null, trend: 0 })
	})
})
