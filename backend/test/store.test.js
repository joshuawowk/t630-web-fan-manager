import fs from "fs"
import os from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createStore, DEFAULT_FAN_CURVE, sanitize, ValidationError } from "../src/store"
import { quietLog, USER_CURVE } from "./helpers"

let dir
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "store-test-"))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const legacy = [
	{
		name: "T630 Fan Manager",
		address: "192.168.0.162",
		username: "root",
		password: "secret",
		warnspeed: "5000",
		manualFanControl: true,
		fancurve: USER_CURVE,
		sensordataRaw: [["Fan1", "1680.000", "RPM"]],
		sensordata: [{ name: "Fan1", value: "1680.000" }],
	},
]

describe("createStore", () => {
	it("migrates a servers.json written by the 2022 image and backs up the original", () => {
		const file = path.join(dir, "servers.json")
		fs.writeFileSync(file, JSON.stringify(legacy))
		const store = createStore({ dataDir: dir, log: quietLog })
		const [server] = store.load()
		expect(server).toMatchObject({ name: "T630 Fan Manager", warnspeed: 5000, manualFanControl: true, fancurve: USER_CURVE, hysteresis: 0, failsafeTemperature: null })
		expect(server.id).toMatch(/^[0-9a-f]{8}$/)
		expect(server).not.toHaveProperty("sensordata")
		expect(JSON.parse(fs.readFileSync(`${file}.v1.bak`, "utf8"))).toEqual(legacy)

		const saved = JSON.parse(fs.readFileSync(file, "utf8"))
		// Empty runtime arrays keep the file loadable by the 2022 image if the stack is rolled back
		expect(saved[0]).toMatchObject({ id: server.id, sensordata: [], sensordataRaw: [], password: "secret" })
		expect(fs.statSync(file).mode & 0o777).toBe(0o600)
		expect(fs.statSync(`${file}.v1.bak`).mode & 0o777).toBe(0o600)

		const again = createStore({ dataDir: dir, log: quietLog })
		expect(again.load()[0].id).toBe(server.id)
	})

	it("starts empty without a file", () => {
		expect(createStore({ dataDir: path.join(dir, "new"), log: quietLog }).load()).toEqual([])
	})

	it("adds, updates and removes servers with validation", () => {
		const store = createStore({ dataDir: dir, log: quietLog })
		store.load()
		const server = store.add({ name: "A", address: "10.0.0.1", username: "root", password: "x" })
		expect(server.fancurve).toEqual(DEFAULT_FAN_CURVE)
		expect(() => store.add({ name: "A", address: "10.0.0.2", username: "root", password: "x" })).toThrow(/already exists/)
		expect(() => store.add({ name: "B", address: "10.0.0.1", username: "root", password: "x" })).toThrow(/already exists/)
		expect(() => store.add({ name: "B", address: "10.0.0.2", username: "root" })).toThrow(/Password is required/)

		const { connectionChanged } = store.update(server.id, { password: "", warnspeed: "4000" })
		expect(connectionChanged).toBe(false)
		expect(server).toMatchObject({ password: "x", warnspeed: 4000 })
		expect(store.update(server.id, { address: "10.0.0.9" }).connectionChanged).toBe(true)

		store.save()
		expect(JSON.parse(fs.readFileSync(store.file, "utf8"))[0].address).toBe("10.0.0.9")
		store.remove(server.id)
		expect(store.servers).toEqual([])
		expect(() => store.update("missing", {})).toThrow(ValidationError)
	})
})

describe("sanitize", () => {
	it("keeps only editable fields", () => {
		expect(sanitize({ name: " T630 ", sensordata: [1], status: {}, hasPassword: true, id: "x" })).toEqual({ name: "T630" })
	})

	it("rejects bad values", () => {
		expect(() => sanitize({ address: "-oProxyCommand=evil" })).toThrow(/Address/)
		expect(() => sanitize({ address: "a b" })).toThrow(/Address/)
		expect(() => sanitize({ fancurve: [10] })).toThrow(/at least 2/)
		expect(() => sanitize({ fancurve: [10, "x"] })).toThrow(/Fan curve/)
		expect(() => sanitize({ manualFanControl: "yes" })).toThrow(/true or false/)
		expect(() => sanitize({ hysteresis: 50 })).toThrow(/between 0 and 20/)
		expect(() => sanitize({ name: "" })).toThrow(/required/)
	})

	it("accepts addresses, numeric strings and clearing the failsafe temperature", () => {
		expect(sanitize({ address: "idrac.home.lan" })).toEqual({ address: "idrac.home.lan" })
		expect(sanitize({ address: "[fe80::1%eth0]" })).toEqual({ address: "[fe80::1%eth0]" })
		expect(sanitize({ warnspeed: "5000", failsafeTemperature: "" })).toEqual({ warnspeed: 5000, failsafeTemperature: null })
		expect(sanitize({ failsafeTemperature: 80 })).toEqual({ failsafeTemperature: 80 })
	})
})
