// End to end: the real server process against the mock ipmitool, driven over socket.io and HTTP
import { spawn } from "child_process"
import fs from "fs"
import net from "net"
import os from "os"
import path from "path"
import { io } from "socket.io-client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { MOCK_IPMITOOL, USER_CURVE, withCpuTemps } from "./helpers"

const PASSWORD = `pa$$ "w0rd" ;$(id)`
let dir, port, child, output, socket
const latest = {}

function freePort() {
	return new Promise((resolve) => {
		const probe = net.createServer().listen(0, () => {
			const { port } = probe.address()
			probe.close(() => resolve(port))
		})
	})
}

const writeState = (state) => fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state))
const setTemps = (cpu1, cpu2) => {
	fs.writeFileSync(path.join(dir, "sensor.txt"), withCpuTemps(cpu1, cpu2))
	writeState({ sensorFile: path.join(dir, "sensor.txt") })
}
const calls = () =>
	fs
		.readFileSync(path.join(dir, "ipmi.log"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line))
const commandsSince = (at) =>
	calls()
		.filter((call) => call.at >= at && call.args.includes("raw"))
		.map((call) => call.args.slice(7).join(" "))
const api = (pathname) => fetch(`http://127.0.0.1:${port}${pathname}`)
const request = (event, payload) => new Promise((resolve) => socket.emit(event, payload, resolve))

async function waitFor(check, { timeout = 10000, what = "condition" } = {}) {
	const started = Date.now()
	for (;;) {
		const value = await check()
		if (value) return value
		if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${what}\n--- server output ---\n${output}`)
		await new Promise((resolve) => setTimeout(resolve, 100))
	}
}

beforeAll(async () => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "server-test-"))
	fs.mkdirSync(path.join(dir, "data"))
	fs.writeFileSync(
		path.join(dir, "data", "servers.json"),
		JSON.stringify([
			{
				name: "T630 Fan Manager",
				address: "192.0.2.162",
				username: "root",
				password: PASSWORD,
				warnspeed: "5000",
				manualFanControl: true,
				fancurve: USER_CURVE,
				sensordataRaw: [],
				sensordata: [],
			},
		])
	)
	setTemps(34, 33)
	port = await freePort()
	output = ""
	child = spawn(process.execPath, [path.join(__dirname, "..", "src", "index.js")], {
		cwd: dir,
		env: {
			...process.env,
			PORT: String(port),
			DATA_DIR: path.join(dir, "data"),
			STATIC_DIR: path.join(dir, "static"),
			IPMITOOL_PATH: MOCK_IPMITOOL,
			MOCK_IPMI_LOG: path.join(dir, "ipmi.log"),
			MOCK_IPMI_STATE: path.join(dir, "state.json"),
			POLL_INTERVAL_SECONDS: "1",
			IPMI_TIMEOUT_SECONDS: "2",
		},
	})
	child.stdout.on("data", (chunk) => (output += chunk))
	child.stderr.on("data", (chunk) => (output += chunk))
	await waitFor(() => output.includes("Listening on port"), { what: "server start" })
	socket = io(`http://127.0.0.1:${port}`, { transports: ["websocket"] })
	socket.on("servers", (servers) => (latest.servers = servers))
	socket.on("sensordata", (data) => (latest.sensordata = data))
	await waitFor(() => latest.servers, { what: "servers event" })
}, 30000)

afterAll(() => {
	socket?.close()
	if (child && child.exitCode === null) child.kill("SIGKILL")
	fs.rmSync(dir, { recursive: true, force: true })
})

describe("server", () => {
	it("never sends the password to the browser", async () => {
		const [server] = latest.servers
		expect(server).toMatchObject({ name: "T630 Fan Manager", hasPassword: true, warnspeed: 5000, manualFanControl: true })
		expect(server).not.toHaveProperty("password")
		expect(server.id).toMatch(/^[0-9a-f]{8}$/)
		const status = await (await api("/api/status")).text()
		expect(status).not.toContain("w0rd")
	})

	it("drives the fans from the curve and reports status", async () => {
		const data = await waitFor(() => latest.sensordata?.status.mode === "manual" && latest.sensordata, { what: "manual mode" })
		expect(data.status).toMatchObject({ targetFanSpeed: 17, controlTemperature: 34, hottestSensor: "Temp", consecutiveFailures: 0 })
		expect(data.sensordata.map((sensor) => sensor.name)).toContain("Temp #2")
		const commands = commandsSince(0)
		expect(commands.slice(0, 2)).toEqual(["raw 0x30 0x30 0x01 0x00", "raw 0x30 0x30 0x02 0xff 0x11"])
		for (const call of calls()) {
			expect(call.password).toBe(PASSWORD)
			expect(call.args.join(" ")).not.toContain("w0rd")
		}
		const health = await api("/healthz")
		expect(health.status).toBe(200)
		const metrics = await (await api("/metrics")).text()
		expect(metrics).toMatch(/servermanager_fan_target_percent\{address="192.0.2.162",host_name="T630 Fan Manager"\} 17/)
		expect(metrics).toMatch(/servermanager_statistics_gauge\{name="Temp #2",type="temperature"/)
		expect(metrics).toMatch(/servermanager_fan_control_mode\{[^}]*mode="manual"\} 1/)
	})

	it("validates updates and acknowledges them", async () => {
		const { id } = latest.servers[0]
		expect(await request("updateServer", { id, update: { fancurve: [10] } })).toMatchObject({ ok: false, error: expect.stringMatching(/at least 2/) })
		expect(await request("updateServer", { id: "nope", update: {} })).toMatchObject({ ok: false, error: "Server not found" })
		const result = await request("updateServer", { id, update: { hysteresis: 2, password: "", sensordata: ["junk"] } })
		expect(result).toMatchObject({ ok: true, server: { hysteresis: 2, hasPassword: true } })
		await waitFor(() => latest.servers[0].hysteresis === 2, { what: "servers broadcast" })
	})

	it("fails safe when the iDRAC stops answering and takes over again when it is back", async () => {
		writeState({ fail: true })
		const data = await waitFor(() => latest.sensordata?.status.mode === "failsafe" && latest.sensordata, { what: "failsafe" })
		expect(data.status.failsafeReason).toMatch(/3 polls in a row failed/)
		expect((await api("/healthz")).status).toBe(503)
		const started = Date.now()
		setTemps(34, 33)
		await waitFor(() => latest.sensordata?.status.mode === "manual", { what: "recovery" })
		expect(commandsSince(started)).toContain("raw 0x30 0x30 0x01 0x00")
	})

	it("hands back to the iDRAC on overheat", async () => {
		const started = Date.now()
		setTemps(92, 40)
		const data = await waitFor(() => latest.sensordata?.status.mode === "failsafe" && latest.sensordata, { what: "overheat failsafe" })
		expect(data.status.failsafeReason).toBe("Temp is 92 °C, at or above its 90 °C limit")
		expect(commandsSince(started)).toContain("raw 0x30 0x30 0x01 0x01")
		setTemps(34, 33)
		await waitFor(() => latest.sensordata?.status.mode === "manual", { what: "overheat recovery" })
	})

	it("hands control back to the iDRAC and saves on SIGTERM", async () => {
		const started = Date.now()
		child.kill("SIGTERM")
		const code = await new Promise((resolve) => child.once("exit", resolve))
		expect(code).toBe(0)
		expect(commandsSince(started).at(-1)).toBe("raw 0x30 0x30 0x01 0x01")
		const file = path.join(dir, "data", "servers.json")
		expect(fs.statSync(file).mode & 0o777).toBe(0o600)
		const [saved] = JSON.parse(fs.readFileSync(file, "utf8"))
		expect(saved).toMatchObject({ hysteresis: 2, password: PASSWORD, sensordata: [], sensordataRaw: [] })
		expect(fs.existsSync(`${file}.v1.bak`)).toBe(true)
		expect(output).not.toContain("w0rd")
		expect(output).toMatch(/Fan control handed back to the iDRAC/)
	})
})
