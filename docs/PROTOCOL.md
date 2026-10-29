# Backend ↔ frontend protocol

The backend (`backend/src`) serves the built frontend, a socket.io **v4** endpoint at `/socket.io`, and a few HTTP endpoints. The frontend talks to it only over socket.io.

## Data shapes

### Server (public view)

The iDRAC password is **never** sent to the browser. `hasPassword` says whether one is stored.

```js
{
	id: "3f9c2a1e",             // stable id (string); use this, not address, to identify a server
	name: "T630 Fan Manager",
	address: "192.168.0.162",   // iDRAC address/hostname
	username: "root",
	hasPassword: true,
	warnspeed: 5000,            // number, RPM; fan readings above it are highlighted
	manualFanControl: true,     // true = this app drives the fans from the curve; false = iDRAC automatic
	fancurve: [10, 10, 12, 20], // >= 2 fan-% points, evenly spaced from 0 °C (first) to 100 °C (last)
	hysteresis: 0,              // °C; fans only slow down after the temperature falls this far
	failsafeTemperature: null,  // °C or null; null = use each sensor's own upper non-critical threshold
	sensordata: [Sensor],
	status: Status,
}
```

### Sensor

One row of `ipmitool sensor`. Rows whose reading is `na` are omitted.

```js
{
	name: "Temp #2",            // unique within a server: duplicate names get " #2", " #3", ...
	value: 34,                  // number for numeric sensors; raw string (e.g. "0x1") for discrete ones
	unit: "degrees C",          // "degrees C" | "RPM" | "Watts" | "Amps" | "Volts" | "percent" | "discrete" | ...
	status: "ok",               // ipmitool status column: "ok" | "nc" | "cr" | "nr" | "ns" | ...
	lowerNonRecoverable: null,  // thresholds: number or null when ipmitool reports "na"
	lowerCritical: 3,
	lowerNonCritical: 8,
	upperNonCritical: 90,
	upperCritical: 95,
	upperNonRecoverable: null,
	previousValue: 33,          // value from the previous poll, or null
	trend: 1,                   // value - previousValue, 0 when unknown
}
```

### Status

Runtime state of the fan controller for one server.

```js
{
	mode: "manual",             // "manual"    – this app is driving the fans
	                            // "automatic" – iDRAC drives the fans (manualFanControl is off)
	                            // "failsafe"  – manualFanControl is on, but control was handed back to the iDRAC (see failsafeReason)
	                            // "unknown"   – no IPMI command has succeeded yet (startup, or iDRAC unreachable)
	targetFanSpeed: 17,         // % last sent to the iDRAC, or null
	controlTemperature: 34,     // °C used for the curve lookup (after hysteresis), or null
	highestTemperature: 34,     // °C of the hottest temperature sensor in the last poll, or null
	hottestSensor: "Temp",      // name of that sensor, or null
	failsafeReason: null,       // human-readable reason when mode is "failsafe", else null
	lastUpdate: 1761700000000,  // ms since epoch of the last successful sensor read, or null
	lastError: null,            // { message: string, at: ms since epoch } of the most recent failure, or null
	consecutiveFailures: 0,     // failed polls in a row
}
```

## socket.io events

### Server → client

| Event | Payload | When |
|---|---|---|
| `servers` | `Server[]` | On connect, and whenever any server's configuration changes |
| `sensordata` | `{ id, name, sensordata: Sensor[], status: Status }` | After every poll of one server (default every 30 s) |

### Client → server

Every request takes an acknowledgement callback as its last argument, called with `{ ok: true, server? }` or `{ ok: false, error: "message" }`.

| Event | Payload | Notes |
|---|---|---|
| `addServer` | `{ server: { name, address, username, password, warnspeed?, manualFanControl?, fancurve?, hysteresis?, failsafeTemperature? } }` | `name`, `address`, `username`, `password` are required. Name and address must be unique. |
| `updateServer` | `{ id, update: { ...any editable field } }` | Editable: `name`, `address`, `username`, `password`, `warnspeed`, `manualFanControl`, `fancurve`, `hysteresis`, `failsafeTemperature`. Omit `password` or send `""` to keep the stored one. |
| `deleteServer` | `{ id }` | Hands fan control back to the iDRAC before removing the server. |

```js
socket.emit("updateServer", { id, update: { manualFanControl: true } }, (result) => {
	if (!result.ok) console.error(result.error)
})
```

## HTTP

| Path | Returns |
|---|---|
| `GET /api/status` | `Server[]` (same shape as the `servers` event) |
| `GET /healthz` | `200 {"ok":true,...}` when the control loop is running and every server was read recently, else `503` with the reasons |
| `GET /metrics` | Prometheus metrics |
| `GET /info` | Plain-text banner |
