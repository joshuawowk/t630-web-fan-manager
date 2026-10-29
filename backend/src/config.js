const path = require("path")

const dev = process.argv[2] === "dev"

function envNumber(name, fallback, { min = -Infinity, max = Infinity } = {}) {
	const raw = process.env[name]
	if (raw === undefined || raw === "") return fallback
	const value = Number(raw)
	if (!Number.isFinite(value)) {
		console.warn(`Ignoring ${name}=${raw}: not a number, using ${fallback}`)
		return fallback
	}
	return Math.max(min, Math.min(max, value))
}

function envBool(name, fallback) {
	const raw = process.env[name]
	if (raw === undefined || raw === "") return fallback
	return ["1", "true", "yes", "on"].includes(raw.toLowerCase())
}

module.exports = {
	dev,
	port: envNumber("PORT", dev ? 8082 : 8080, { min: 1, max: 65535 }),
	dataDir: path.resolve(process.env.DATA_DIR || "data"),
	staticDir: path.resolve(process.env.STATIC_DIR || "build"),
	pollIntervalMs: envNumber("POLL_INTERVAL_SECONDS", 30, { min: 1, max: 600 }) * 1000,
	ipmiTimeoutMs: envNumber("IPMI_TIMEOUT_SECONDS", 20, { min: 1, max: 120 }) * 1000,
	ipmitoolPath: process.env.IPMITOOL_PATH || "ipmitool",
	// Consecutive failed polls before a server under app control is handed back to the iDRAC
	failsafeReadFailures: envNumber("FAILSAFE_READ_FAILURES", 3, { min: 1, max: 100 }),
	restoreAutoOnExit: envBool("RESTORE_AUTO_ON_EXIT", true),
	// Dry run reads sensors but never sends fan commands. On by default in dev mode.
	dryRun: envBool("DRY_RUN", dev),
}
