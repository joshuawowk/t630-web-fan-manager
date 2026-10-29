import { vi } from "vitest"

vi.mock("socket.io-client", () => ({ io: () => ({ on: vi.fn(), emit: vi.fn(), connected: true }) }))

import { createRequest } from "./index"

function fakeSocket(behaviour, connected = true) {
	const timeout = vi.fn((ms) => ({ emit: (event, payload, ack) => behaviour(ack, { ms, event, payload }) }))
	return { socket: { connected, timeout }, timeout }
}

describe("request", () => {
	it("resolves with the ack payload", async () => {
		const { socket, timeout } = fakeSocket((ack) => ack(null, { ok: true, server: { id: "a" } }))
		const result = await createRequest(socket)("addServer", { server: {} })
		expect(result).toEqual({ ok: true, server: { id: "a" } })
		expect(timeout).toHaveBeenCalledWith(10000)
	})
	it("passes an explicit timeout through", async () => {
		const { socket, timeout } = fakeSocket((ack) => ack(null, { ok: true }))
		await createRequest(socket)("deleteServer", { id: "a" }, 250)
		expect(timeout).toHaveBeenCalledWith(250)
	})
	it("resolves ok:false when the server does not answer in time", async () => {
		const { socket } = fakeSocket((ack) => ack(new Error("operation has timed out")))
		expect(await createRequest(socket)("updateServer", {})).toEqual({ ok: false, error: "Timed out waiting for the server" })
	})
	it("resolves ok:false without emitting while disconnected", async () => {
		const { socket, timeout } = fakeSocket(() => {}, false)
		const result = await createRequest(socket)("updateServer", {})
		expect(result.ok).toBe(false)
		expect(timeout).not.toHaveBeenCalled()
	})
})
