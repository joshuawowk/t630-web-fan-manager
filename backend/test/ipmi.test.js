import fs from "fs"
import os from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { clampSpeed, createIpmi, redact } from "../src/ipmi"
import { MOCK_IPMITOOL } from "./helpers"

const PASSWORD = `p@ss $(touch /tmp/pwned) "quoted" ;rm -rf ~`
const config = { address: "192.0.2.10", username: "root", password: PASSWORD }

let dir
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipmi-test-"))
	process.env.MOCK_IPMI_LOG = path.join(dir, "log")
	process.env.MOCK_IPMI_STATE = path.join(dir, "state.json")
})
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true })
	delete process.env.MOCK_IPMI_LOG
	delete process.env.MOCK_IPMI_STATE
})

const calls = () =>
	fs
		.readFileSync(process.env.MOCK_IPMI_LOG, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line))
const setState = (state) => fs.writeFileSync(process.env.MOCK_IPMI_STATE, JSON.stringify(state))

describe("createIpmi", () => {
	it("passes the password through the environment, never as an argument", async () => {
		const ipmi = createIpmi({ ipmitoolPath: MOCK_IPMITOOL })
		const output = await ipmi.getSensors(config)
		expect(output).toContain("Inlet Temp")
		const [call] = calls()
		expect(call.args).toEqual(["-I", "lanplus", "-H", "192.0.2.10", "-U", "root", "-E", "sensor"])
		expect(call.password).toBe(PASSWORD)
		expect(JSON.stringify(call.args)).not.toContain("p@ss")
	})

	it("sends the Dell raw commands for manual, automatic and speed", async () => {
		const ipmi = createIpmi({ ipmitoolPath: MOCK_IPMITOOL })
		await ipmi.enableManualFancontrol(config)
		await ipmi.setFanSpeed(config, 17)
		await ipmi.setFanSpeed(config, 250)
		await ipmi.enableAutomaticFancontrol(config)
		expect(calls().map((call) => call.args.slice(7).join(" "))).toEqual([
			"raw 0x30 0x30 0x01 0x00",
			"raw 0x30 0x30 0x02 0xff 0x11",
			"raw 0x30 0x30 0x02 0xff 0x64",
			"raw 0x30 0x30 0x01 0x01",
		])
	})

	it("reports failures without leaking the password", async () => {
		setState({ fail: true })
		const ipmi = createIpmi({ ipmitoolPath: MOCK_IPMITOOL })
		const error = await ipmi.getSensors(config).catch((e) => e)
		expect(error.name).toBe("IpmiError")
		expect(error.message).toMatch(/ipmitool sensor failed \(exit code 1\): Error: Unable to establish IPMI v2/)
		expect(error.message).not.toContain("p@ss")
		expect(error.message).not.toContain("-P")
	})

	it("does not leak a password that execFile rejects", async () => {
		const error = await createIpmi({ ipmitoolPath: MOCK_IPMITOOL })
			.getSensors({ ...config, password: "hunter2\u0000x" })
			.catch((e) => e)
		expect(error.name).toBe("IpmiError")
		expect(error.message).toMatch(/could not be started/)
		expect(error.message).not.toContain("hunter2")
	})

	it("reports a segfaulting ipmitool", async () => {
		setState({ segv: true })
		const error = await createIpmi({ ipmitoolPath: MOCK_IPMITOOL })
			.getSensors(config)
			.catch((e) => e)
		expect(error.message).toMatch(/killed by SIGSEGV/)
	})

	it("kills ipmitool when it hangs", async () => {
		setState({ hang: true })
		const started = Date.now()
		const error = await createIpmi({ ipmitoolPath: MOCK_IPMITOOL, timeoutMs: 500 })
			.getSensors(config)
			.catch((e) => e)
		expect(error.timedOut).toBe(true)
		expect(error.message).toMatch(/timed out after 1s/)
		expect(Date.now() - started).toBeLessThan(5000)
	})

	it("reports a missing ipmitool binary", async () => {
		const error = await createIpmi({ ipmitoolPath: path.join(dir, "nope") })
			.getSensors(config)
			.catch((e) => e)
		expect(error.message).toMatch(/not found/)
	})

	it("reads sensors but sends no fan commands in dry-run mode", async () => {
		const ipmi = createIpmi({ ipmitoolPath: MOCK_IPMITOOL, dryRun: true })
		await ipmi.getSensors(config)
		await ipmi.enableManualFancontrol(config)
		await ipmi.setFanSpeed(config, 50)
		await ipmi.enableAutomaticFancontrol(config)
		expect(calls().map((call) => call.args.at(-1))).toEqual(["sensor"])
	})
})

describe("clampSpeed", () => {
	it("rounds and clamps to 0-100", () => {
		expect(clampSpeed(16.6)).toBe(17)
		expect(clampSpeed(-3)).toBe(0)
		expect(clampSpeed(101)).toBe(100)
		expect(() => clampSpeed("fast")).toThrow()
	})
})

describe("redact", () => {
	it("removes every occurrence of each secret", () => {
		expect(redact("a hunter2 b hunter2", ["hunter2", ""])).toBe("a <redacted> b <redacted>")
	})
})
