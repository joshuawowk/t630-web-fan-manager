import { io } from "socket.io-client"

const TIMEOUT_MESSAGE = "Timed out waiting for the server"

// Sends an event and resolves with the server's ack ({ ok, ... }); never rejects.
export function createRequest(socket) {
	return (event, payload, timeoutMs = 10000) =>
		new Promise((resolve) => {
			if (socket.connected === false) {
				resolve({ ok: false, error: "Not connected to the server" })
				return
			}
			socket.timeout(timeoutMs).emit(event, payload, (err, result) => {
				if (err) resolve({ ok: false, error: TIMEOUT_MESSAGE })
				else resolve(result ?? { ok: false, error: "Empty response from the server" })
			})
		})
}

const socketOrigin = import.meta.env.VITE_SOCKET_ORIGIN ?? window.location.origin
export const socket = io(socketOrigin, {
	path: "/socket.io",
	transports: ["websocket", "polling"],
})

socket.on("connect", () => socket.emit("registerWebclient"))

export const request = createRequest(socket)
