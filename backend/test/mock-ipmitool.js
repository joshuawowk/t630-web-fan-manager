#!/usr/bin/env node
// Stand-in for ipmitool in tests. Behaviour comes from the JSON file in MOCK_IPMI_STATE, re-read on every
// call so a test can change it while the app runs; every invocation is appended to MOCK_IPMI_LOG.
const fs = require("fs")
const path = require("path")

const args = process.argv.slice(2)
let state = {}
try {
	state = JSON.parse(fs.readFileSync(process.env.MOCK_IPMI_STATE, "utf8"))
} catch (e) {}

if (process.env.MOCK_IPMI_LOG) {
	fs.appendFileSync(process.env.MOCK_IPMI_LOG, JSON.stringify({ args, password: process.env.IPMI_PASSWORD ?? null, at: Date.now() }) + "\n")
}

const command = args.slice(args.indexOf("-E") + 1)
if (state.hang) setTimeout(() => {}, 60000)
else if (state.segv) process.kill(process.pid, "SIGSEGV")
else if (state.fail) {
	process.stderr.write("Error: Unable to establish IPMI v2 / RMCP+ session\n")
	process.exit(1)
} else if (command[0] === "sensor") {
	process.stdout.write(fs.readFileSync(state.sensorFile || path.join(__dirname, "fixtures", "t630-sensor.txt"), "utf8"))
} else if (command[0] !== "raw") {
	process.stderr.write(`mock-ipmitool: unsupported command ${command.join(" ")}\n`)
	process.exit(1)
}
