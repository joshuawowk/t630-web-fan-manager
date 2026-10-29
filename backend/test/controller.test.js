import { describe, expect, it } from "vitest"
import { FanController } from "../src/controller"
import { fakeIpmi, quietLog, USER_CURVE, withCpuTemps } from "./helpers"

function setup(overrides = {}, options = {}) {
	const server = {
		id: "s1",
		name: "T630",
		address: "192.0.2.10",
		username: "root",
		password: "secret",
		manualFanControl: true,
		fancurve: USER_CURVE,
		hysteresis: 0,
		...overrides,
	}
	const servers = [server]
	const ipmi = fakeIpmi()
	const polls = []
	let clock = 1_000_000
	const controller = new FanController({
		ipmi,
		getServers: () => servers,
		log: quietLog,
		now: () => clock,
		onPoll: (config, state) => polls.push(structuredClone(controller.status(config.id))),
		...options,
	})
	return { server, servers, ipmi, polls, controller, advance: (ms) => (clock += ms) }
}

describe("FanController", () => {
	it("re-asserts manual mode on every poll, not just at startup", async () => {
		const { controller, ipmi } = setup()
		await controller.poll("s1")
		await controller.poll("s1")
		expect(ipmi.commands()).toEqual([["manual"], ["speed", 17], ["manual"], ["speed", 17]])
		expect(controller.status("s1")).toMatchObject({ mode: "manual", targetFanSpeed: 17, controlTemperature: 34, highestTemperature: 34, hottestSensor: "Temp" })
	})

	it("hands control to the iDRAC once when custom control is off", async () => {
		const { controller, ipmi } = setup({ manualFanControl: false })
		await controller.poll("s1")
		await controller.poll("s1")
		expect(ipmi.commands()).toEqual([["automatic"]])
		expect(controller.status("s1")).toMatchObject({ mode: "automatic", targetFanSpeed: null })
	})

	it("hands back to the iDRAC after repeated failed reads, and takes over again when they recover", async () => {
		const { controller, ipmi, server } = setup()
		await controller.poll("s1")
		ipmi.failReads = true
		ipmi.reset()
		await controller.poll("s1")
		await controller.poll("s1")
		expect(controller.status("s1")).toMatchObject({ mode: "manual", consecutiveFailures: 2 })
		expect(ipmi.commands()).toEqual([])
		await controller.poll("s1")
		expect(controller.status("s1").mode).toBe("failsafe")
		expect(controller.status("s1").failsafeReason).toMatch(/3 polls in a row failed/)
		expect(ipmi.commands()).toEqual([["automatic"]])
		await controller.poll("s1")
		expect(ipmi.commands()).toEqual([["automatic"]])

		ipmi.failReads = false
		ipmi.reset()
		await controller.poll("s1")
		expect(controller.status("s1")).toMatchObject({ mode: "manual", consecutiveFailures: 0, failsafeReason: null })
		expect(ipmi.commands()).toEqual([["manual"], ["speed", 17]])
		expect(server.manualFanControl).toBe(true)
	})

	it("hands back to the iDRAC when a temperature reaches its threshold, and recovers only once well below it", async () => {
		const { controller, ipmi } = setup()
		await controller.poll("s1")
		ipmi.sensorText = withCpuTemps(91, 60)
		ipmi.reset()
		await controller.poll("s1")
		expect(controller.status("s1")).toMatchObject({ mode: "failsafe", targetFanSpeed: null })
		expect(controller.status("s1").failsafeReason).toBe("Temp is 91 °C, at or above its 90 °C limit")
		expect(ipmi.commands()).toEqual([["automatic"]])

		ipmi.sensorText = withCpuTemps(87, 60)
		await controller.poll("s1")
		expect(controller.status("s1").mode).toBe("failsafe")
		expect(ipmi.commands()).toEqual([["automatic"]])

		ipmi.sensorText = withCpuTemps(80, 60)
		ipmi.reset()
		await controller.poll("s1")
		expect(controller.status("s1")).toMatchObject({ mode: "manual", failsafeReason: null })
		// 80 °C is 80% of the way from 60 % (75 °C) to 75 % (81.25 °C)
		expect(ipmi.commands()).toEqual([["manual"], ["speed", 72]])
	})

	it("honours a lower configured failsafe temperature", async () => {
		const { controller, ipmi } = setup({ failsafeTemperature: 50 })
		ipmi.sensorText = withCpuTemps(52)
		await controller.poll("s1")
		expect(controller.status("s1").failsafeReason).toMatch(/50 °C limit/)
	})

	it("hands back to the iDRAC when there are no temperature readings", async () => {
		const { controller, ipmi } = setup()
		ipmi.sensorText = "Fan1             | 1320.000   | RPM        | ok    | na        | 240.000   | 360.000   | na        | na        | na\n"
		await controller.poll("s1")
		expect(controller.status("s1")).toMatchObject({ mode: "failsafe", failsafeReason: "the iDRAC reported no temperature readings" })
		expect(ipmi.commands()).toEqual([["automatic"]])
	})

	it("records write failures and fails safe after repeated ones", async () => {
		const { controller, ipmi } = setup()
		ipmi.failWrites = true
		await controller.poll("s1")
		expect(controller.status("s1")).toMatchObject({ mode: "unknown", consecutiveFailures: 1 })
		expect(controller.status("s1").lastError.message).toBe("ipmitool raw failed")
		await controller.poll("s1")
		await controller.poll("s1")
		expect(controller.status("s1").mode).toBe("failsafe")
	})

	it("applies hysteresis across polls", async () => {
		const { controller, ipmi } = setup({ fancurve: [0, 100], hysteresis: 3 })
		ipmi.sensorText = withCpuTemps(50)
		await controller.poll("s1")
		ipmi.sensorText = withCpuTemps(48)
		await controller.poll("s1")
		expect(controller.status("s1")).toMatchObject({ controlTemperature: 50, targetFanSpeed: 50, highestTemperature: 48 })
		ipmi.sensorText = withCpuTemps(46)
		await controller.poll("s1")
		expect(controller.status("s1")).toMatchObject({ controlTemperature: 46, targetFanSpeed: 46 })
	})

	it("releases a server back to the iDRAC", async () => {
		const { controller, ipmi, server } = setup()
		await controller.poll("s1")
		ipmi.reset()
		expect(await controller.release(server)).toBe(true)
		expect(ipmi.commands()).toEqual([["automatic"]])
		const other = setup({ manualFanControl: false })
		await other.controller.poll("s1")
		other.ipmi.reset()
		expect(await other.controller.release(other.server)).toBe(false)
		expect(other.ipmi.commands()).toEqual([])
	})

	it("serializes work for one server", async () => {
		const { controller } = setup()
		const order = []
		const slow = controller.enqueue("s1", () => new Promise((resolve) => setTimeout(() => resolve(order.push("slow")), 30)))
		const fast = controller.enqueue("s1", () => order.push("fast"))
		await Promise.all([slow, fast])
		expect(order).toEqual(["slow", "fast"])
	})

	it("keeps the queue going after a task throws", async () => {
		const { controller } = setup()
		await expect(controller.enqueue("s1", () => Promise.reject(new Error("boom")))).rejects.toThrow("boom")
		await expect(controller.enqueue("s1", () => "ok")).resolves.toBe("ok")
	})

	it("hands every app-controlled server back to the iDRAC on shutdown and stops sending manual commands", async () => {
		const { controller, ipmi, servers } = setup()
		servers.push({ ...servers[0], id: "s2", name: "auto box", manualFanControl: false })
		await controller.poll("s1")
		await controller.poll("s2")
		ipmi.reset()
		await controller.shutdown()
		expect(ipmi.commands()).toEqual([["automatic"]])
		await controller.poll("s1")
		expect(ipmi.calls).toEqual([["automatic"]])
	})

	it("reports health, including stale readings and failsafe", async () => {
		const { controller, ipmi, advance } = setup({}, { pollIntervalMs: 30000 })
		await controller.runCycle()
		expect(controller.health()).toMatchObject({ ok: true, problems: [] })
		ipmi.sensorText = withCpuTemps(95)
		await controller.runCycle()
		expect(controller.health().ok).toBe(false)
		expect(controller.health().problems[0]).toMatch(/failsafe/)
		ipmi.sensorText = withCpuTemps(34)
		ipmi.failReads = true
		advance(6 * 60 * 1000)
		expect(controller.health().problems.join(" ")).toMatch(/no sensor reading for 360 s/)
		expect(controller.health().problems.join(" ")).toMatch(/has not completed a cycle/)
	})

	it("publishes status after every poll, including failed ones", async () => {
		const { controller, ipmi, polls } = setup()
		await controller.poll("s1")
		ipmi.failReads = true
		await controller.poll("s1")
		expect(polls.map((status) => status.mode)).toEqual(["manual", "manual"])
		expect(polls[1].lastError.message).toMatch(/sensor failed/)
		expect(polls[1].consecutiveFailures).toBe(1)
	})

	it("keeps polling after an unexpected error in a cycle", async () => {
		const { controller, servers, ipmi } = setup()
		servers.unshift({ id: "bad", name: "bad" })
		ipmi.getSensors = async (config) => {
			if (config.id === "bad") throw new TypeError("unexpected")
			return withCpuTemps(34)
		}
		await controller.runCycle()
		expect(controller.status("s1").mode).toBe("manual")
		expect(controller.status("bad").lastError.message).toBe("unexpected")
	})
})
