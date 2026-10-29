import React, { useEffect, useState } from "react"
import { Alert, Card, Col, Divider, Row, Statistic, Tag, Tooltip, Typography } from "antd"
import { ArrowDownOutlined, ArrowUpOutlined } from "@ant-design/icons"
import { sensorColor } from "../lib/sensors"
import { modeTag, secondsSince, shouldShowError, STALE_SECONDS } from "../lib/status"

function useNow(intervalMs = 1000) {
	const [now, setNow] = useState(() => Date.now())
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), intervalMs)
		return () => clearInterval(timer)
	}, [intervalMs])
	return now
}

const isNumber = (x) => typeof x === "number"
const orDash = (x, suffix) => (isNumber(x) ? `${x}${suffix}` : "–")

export function StatusPanel({ status, now }) {
	const tick = useNow()
	const current = now ?? tick
	if (!status) return null
	const tag = modeTag(status.mode)
	const age = secondsSince(status.lastUpdate, current)
	const stale = age !== null && age > STALE_SECONDS

	return (
		<div style={{ marginBottom: 16 }}>
			<div style={{ marginBottom: 12 }}>
				<Tag color={tag.color}>{tag.text}</Tag>
				{status.mode === "failsafe" && status.failsafeReason && <Typography.Text type="danger">{status.failsafeReason}</Typography.Text>}
			</div>
			<Row gutter={[16, 16]}>
				<Col xs={12} md={6}>
					<Statistic title="Target fan speed" value={orDash(status.targetFanSpeed, " %")} />
				</Col>
				<Col xs={12} md={6}>
					<Statistic title="Control temperature" value={orDash(status.controlTemperature, " °C")} />
				</Col>
				<Col xs={12} md={6}>
					<Statistic title="Hottest sensor" value={status.hottestSensor ? `${status.hottestSensor} (${orDash(status.highestTemperature, " °C")})` : "–"} />
				</Col>
				<Col xs={12} md={6}>
					<Statistic title="Last update" value={age === null ? "never" : `${age} s ago`} valueStyle={stale ? { color: "#fa8c16" } : undefined} />
				</Col>
			</Row>
			{shouldShowError(status) && <Alert style={{ marginTop: 16 }} type="error" showIcon message={status.lastError.message} />}
		</div>
	)
}

function SensorSection({ title, sensors, warnspeed, precision = 0, unitLabel }) {
	if (sensors.length === 0) return null
	return (
		<>
			<Divider orientation="left">{title}</Divider>
			<Row gutter={[16, 16]}>
				{sensors.map((sensor) => (
					<Tooltip key={sensor.name} title={isNumber(sensor.previousValue) ? `Previous value: ${sensor.previousValue}` : "No previous value"}>
						<Col xs={12} md={8} xl={4}>
							<Statistic
								title={sensor.name}
								value={sensor.value}
								precision={sensor.unit === "Amps" ? 2 : precision}
								suffix={
									<span>
										{unitLabel ?? sensor.unit} {(sensor.trend > 0 && <ArrowUpOutlined />) || (sensor.trend < 0 && <ArrowDownOutlined />)}
									</span>
								}
								valueStyle={{ color: sensorColor(sensor, warnspeed) }}
							/>
						</Col>
					</Tooltip>
				))}
			</Row>
		</>
	)
}

export default function ServerOverview({ server, now }) {
	const sensors = server.sensordata ?? []
	const byUnit = (units) => sensors.filter((x) => units.includes(x.unit))
	return (
		<Card>
			<Typography.Title>{server.name}</Typography.Title>
			<StatusPanel status={server.status} now={now} />
			<SensorSection title="Power" sensors={byUnit(["Volts", "Amps", "Watts"])} warnspeed={server.warnspeed} precision={0} />
			<SensorSection title="Temperature" sensors={byUnit(["degrees C"])} warnspeed={server.warnspeed} unitLabel="°C" />
			<SensorSection title="Fans" sensors={byUnit(["RPM"])} warnspeed={server.warnspeed} />
			<SensorSection title="Utilisation" sensors={byUnit(["percent"])} warnspeed={server.warnspeed} unitLabel="%" />
		</Card>
	)
}
