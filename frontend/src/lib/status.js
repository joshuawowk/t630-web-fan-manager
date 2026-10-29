export const STALE_SECONDS = 120

const MODE_TAGS = {
	manual: { color: "blue", text: "App fan control" },
	automatic: { color: "default", text: "iDRAC automatic" },
	failsafe: { color: "red", text: "Failsafe" },
	unknown: { color: "orange", text: "Unknown" },
}

export function modeTag(mode) {
	return MODE_TAGS[mode] ?? MODE_TAGS.unknown
}

export function shouldShowError(status) {
	const lastError = status?.lastError
	if (!lastError) return false
	return lastError.at >= (status.lastUpdate ?? 0) || status.consecutiveFailures > 0
}

export function secondsSince(timestamp, now) {
	if (typeof timestamp !== "number") return null
	return Math.max(0, Math.round((now - timestamp) / 1000))
}
