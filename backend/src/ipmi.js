const { execFile } = require("child_process")

class IpmiError extends Error {
	constructor(message, { operation, code, signal, timedOut } = {}) {
		super(message)
		this.name = "IpmiError"
		this.operation = operation
		this.code = code
		this.signal = signal
		this.timedOut = Boolean(timedOut)
	}
}

function redact(text, secrets) {
	let result = String(text ?? "")
	for (const secret of secrets) {
		if (secret) result = result.split(String(secret)).join("<redacted>")
	}
	return result
}

function summarize(output) {
	return String(output ?? "")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.slice(0, 3)
		.join(" / ")
}

function clampSpeed(speed) {
	const numeric = Math.round(Number(speed))
	if (!Number.isFinite(numeric)) throw new TypeError(`Invalid fan speed: ${speed}`)
	return Math.max(0, Math.min(100, numeric))
}

function createIpmi({ ipmitoolPath = "ipmitool", timeoutMs = 20000, dryRun = false } = {}) {
	// The password goes through IPMI_PASSWORD (-E) and arguments are passed without a shell, so it never
	// appears in a command line, a process listing or an error message, and shell metacharacters are inert.
	function run(config, args, { operation = args[0], timeout = timeoutMs } = {}) {
		const argv = ["-I", "lanplus", "-H", String(config.address), "-U", String(config.username), "-E", ...args]
		return new Promise((resolve, reject) => {
			execFile(
				ipmitoolPath,
				argv,
				{
					env: { ...process.env, IPMI_PASSWORD: String(config.password ?? "") },
					timeout,
					killSignal: "SIGKILL",
					maxBuffer: 4 * 1024 * 1024,
				},
				(error, stdout, stderr) => {
					if (!error) return resolve({ stdout, stderr })
					let detail
					if (error.code === "ENOENT") detail = `${ipmitoolPath} not found`
					else if (error.killed) detail = `timed out after ${Math.round(timeout / 1000)}s`
					else if (error.signal) detail = `killed by ${error.signal}`
					else detail = `exit code ${error.code}`
					const output = summarize(stderr || stdout)
					const message = redact(`ipmitool ${args.join(" ")} failed (${detail})${output ? `: ${output}` : ""}`, [config.password])
					reject(new IpmiError(message, { operation, code: error.code, signal: error.signal, timedOut: error.killed }))
				}
			)
		})
	}

	function write(config, args, options) {
		if (dryRun) return Promise.resolve({ stdout: "", stderr: "", dryRun: true })
		return run(config, args, options)
	}

	return {
		dryRun,
		run,
		async getSensors(config, options) {
			const { stdout } = await run(config, ["sensor"], { operation: "sensor", ...options })
			return stdout
		},
		enableManualFancontrol(config, options) {
			return write(config, ["raw", "0x30", "0x30", "0x01", "0x00"], { operation: "manual", ...options })
		},
		enableAutomaticFancontrol(config, options) {
			return write(config, ["raw", "0x30", "0x30", "0x01", "0x01"], { operation: "automatic", ...options })
		},
		setFanSpeed(config, speed, options) {
			const hex = "0x" + clampSpeed(speed).toString(16).padStart(2, "0")
			return write(config, ["raw", "0x30", "0x30", "0x02", "0xff", hex], { operation: "speed", ...options })
		},
	}
}

module.exports = {
	IpmiError,
	clampSpeed,
	createIpmi,
	redact,
}
