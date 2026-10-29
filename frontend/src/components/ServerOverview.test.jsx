import React from "react"
import { render, screen } from "@testing-library/react"
import { Form } from "antd"
import ServerOverview, { StatusPanel } from "./ServerOverview"
import FanCurveGraph from "./FanCurveGraph"

const NOW = 1761700100000

const status = (over = {}) => ({
	mode: "manual",
	targetFanSpeed: 17,
	controlTemperature: 34,
	highestTemperature: 34,
	hottestSensor: "Temp",
	failsafeReason: null,
	lastUpdate: NOW - 5000,
	lastError: null,
	consecutiveFailures: 0,
	...over,
})

const sensor = (over) => ({ status: "ok", lowerNonCritical: null, upperNonCritical: null, previousValue: null, trend: 0, ...over })

const server = (over = {}) => ({
	id: "abc",
	name: "T630",
	warnspeed: 5000,
	status: status(),
	sensordata: [
		sensor({ name: "Pwr Consumption", value: 140, unit: "Watts" }),
		sensor({ name: "Temp", value: 34, unit: "degrees C", upperNonCritical: 90 }),
		sensor({ name: "Inlet Temp", value: 95, unit: "degrees C", upperNonCritical: 42 }),
		sensor({ name: "Fan1", value: 2400, unit: "RPM" }),
		sensor({ name: "CPU Usage", value: 3, unit: "percent" }),
	],
	...over,
})

describe("StatusPanel", () => {
	it.each([
		["manual", "App fan control"],
		["automatic", "iDRAC automatic"],
		["failsafe", "Failsafe"],
		["unknown", "Unknown"],
	])("shows the %s mode tag", (mode, text) => {
		render(<StatusPanel status={status({ mode })} now={NOW} />)
		expect(screen.getByText(text)).toBeInTheDocument()
	})

	it("shows the failsafe reason", () => {
		render(<StatusPanel status={status({ mode: "failsafe", failsafeReason: "Temp at 95 C exceeds 90 C" })} now={NOW} />)
		expect(screen.getByText("Temp at 95 C exceeds 90 C")).toBeInTheDocument()
	})

	it("shows targets, hottest sensor and age", () => {
		render(<StatusPanel status={status()} now={NOW} />)
		expect(screen.getByText("17 %")).toBeInTheDocument()
		expect(screen.getByText("34 °C")).toBeInTheDocument()
		expect(screen.getByText("Temp (34 °C)")).toBeInTheDocument()
		expect(screen.getByText("5 s ago")).toBeInTheDocument()
	})

	it("warns when the last update is stale", () => {
		render(<StatusPanel status={status({ lastUpdate: NOW - 200000 })} now={NOW} />)
		expect(screen.getByText("200 s ago").closest(".ant-statistic-content")).toHaveStyle({ color: "#fa8c16" })
	})

	it("shows an alert for a fresh error", () => {
		render(<StatusPanel status={status({ lastError: { message: "IPMI timeout", at: NOW - 1000 } })} now={NOW} />)
		expect(screen.getByText("IPMI timeout")).toBeInTheDocument()
	})

	it("shows an alert when polls keep failing even if the error is older than the last update", () => {
		render(<StatusPanel status={status({ lastError: { message: "still failing", at: NOW - 60000 }, consecutiveFailures: 2 })} now={NOW} />)
		expect(screen.getByText("still failing")).toBeInTheDocument()
	})

	it("hides a stale, recovered error", () => {
		render(<StatusPanel status={status({ lastError: { message: "old problem", at: NOW - 60000 } })} now={NOW} />)
		expect(screen.queryByText("old problem")).not.toBeInTheDocument()
	})
})

describe("ServerOverview", () => {
	it("renders the sensor sections and colours only real alerts", () => {
		render(<ServerOverview server={server()} now={NOW} />)
		for (const title of ["Power", "Temperature", "Fans", "Utilisation"]) expect(screen.getByText(title)).toBeInTheDocument()
		const content = (name) => screen.getByText(name).closest(".ant-statistic").querySelector(".ant-statistic-content")
		expect(content("Temp")).not.toHaveStyle({ color: "#cf1322" })
		expect(content("Inlet Temp")).toHaveStyle({ color: "#cf1322" })
		expect(content("Fan1")).not.toHaveStyle({ color: "#cf1322" })
	})

	it("colours fans above warnspeed", () => {
		render(<ServerOverview server={server({ warnspeed: 2000 })} now={NOW} />)
		expect(screen.getByText("Fan1").closest(".ant-statistic").querySelector(".ant-statistic-content")).toHaveStyle({ color: "#cf1322" })
	})
})

describe("FanCurveGraph", () => {
	const renderGraph = (operatingPoint) =>
		render(
			<Form initialValues={{ fancurve: [10, 20, 30] }}>
				<FanCurveGraph operatingPoint={operatingPoint} />
			</Form>
		)

	it("labels points at rounded temperatures", () => {
		renderGraph()
		expect(screen.getByText("0°C")).toBeInTheDocument()
		expect(screen.getByText("50°C")).toBeInTheDocument()
		expect(screen.getByText("100°C")).toBeInTheDocument()
	})

	it("draws the operating point when both values are numbers", () => {
		renderGraph({ temperature: 34, speed: 17 })
		expect(screen.getByText("34 °C → 17 %")).toBeInTheDocument()
	})

	it("omits the operating point when a value is null", () => {
		renderGraph({ temperature: null, speed: 17 })
		expect(screen.queryByText(/→/)).not.toBeInTheDocument()
	})
})
