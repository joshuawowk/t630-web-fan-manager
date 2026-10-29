import React, { useEffect, useMemo } from "react"
import { Button, Col, Divider, Form, Input, InputNumber, Popconfirm, Row, message } from "antd"
import { DeleteOutlined, SaveOutlined } from "@ant-design/icons"
import { request } from "../api"
import Switch from "./Switch"
import FanCurveGraph from "./FanCurveGraph"

const layout = { labelCol: { span: 8 }, wrapperCol: { span: 16 } }
const tailLayout = { wrapperCol: { offset: 8, span: 16 } }
const CONFIG_FIELDS = ["name", "address", "username", "warnspeed", "manualFanControl", "fancurve", "hysteresis", "failsafeTemperature"]

function configOf(server) {
	return Object.fromEntries(CONFIG_FIELDS.map((key) => [key, server[key]]))
}

export default function ServerForm({ server }) {
	const [form] = Form.useForm()
	const config = useMemo(() => configOf(server), [server])
	const configKey = JSON.stringify(config)

	// Pick up config changes broadcast by the backend unless the user is mid-edit
	useEffect(() => {
		if (!form.isFieldsTouched()) form.setFieldsValue(config)
	}, [configKey]) // eslint-disable-line react-hooks/exhaustive-deps

	const onFinish = async (values) => {
		// A cleared InputNumber gives null: hysteresis falls back to off, failsafe temperature to the sensors' thresholds
		const update = { ...values, hysteresis: values.hysteresis ?? 0, failsafeTemperature: values.failsafeTemperature ?? null }
		if (!update.password) delete update.password
		const result = await request("updateServer", { id: server.id, update })
		if (result.ok) {
			message.success("Saved")
			// Reset clears touched state (and the password box); re-applying the saved values keeps the form from flashing stale ones until the broadcast arrives
			const { password, ...saved } = update
			form.resetFields()
			form.setFieldsValue(saved)
		} else {
			message.error(result.error)
		}
	}

	const onDelete = async () => {
		const result = await request("deleteServer", { id: server.id })
		if (!result.ok) message.error(result.error)
	}

	const status = server.status
	const operatingPoint = { temperature: status?.controlTemperature, speed: status?.targetFanSpeed }

	return (
		<Form {...layout} form={form} name={`server-${server.id}`} initialValues={config} onFinish={onFinish}>
			<Form.Item label="Name" name="name" rules={[{ required: true, message: "Please input a server name" }]}>
				<Input />
			</Form.Item>
			<Form.Item label="Address/hostname" name="address" rules={[{ required: true, message: "Please input idrac address/hostname" }]}>
				<Input />
			</Form.Item>
			<Form.Item label="Username" name="username" rules={[{ required: true, message: "Please input idrac username (usually root)" }]}>
				<Input />
			</Form.Item>
			<Form.Item label="Password" name="password">
				<Input.Password placeholder={server.hasPassword ? "Unchanged" : undefined} autoComplete="new-password" />
			</Form.Item>
			<Form.Item label="Warning Speed (RPM)" name="warnspeed" rules={[{ required: true, message: "Please input the fan threshold RPM" }]}>
				<InputNumber min={0} />
			</Form.Item>
			<Divider>Custom fan control</Divider>
			<Form.Item label="Custom fan control" name="manualFanControl">
				<Switch checkedChildren="Enabled" unCheckedChildren="Disabled" />
			</Form.Item>
			<Form.Item label="Hysteresis (°C)" name="hysteresis" help="Fans only slow down after the temperature drops this many °C">
				<InputNumber min={0} max={20} />
			</Form.Item>
			<Form.Item
				label="Failsafe temperature (°C)"
				name="failsafeTemperature"
				help="Hand fans back to the iDRAC at this temperature. Blank = each sensor's own warning threshold"
			>
				<InputNumber min={30} max={110} />
			</Form.Item>
			<Row>
				<Col span={layout.labelCol.span}></Col>
				<Col span={layout.wrapperCol.span}>
					<FanCurveGraph operatingPoint={operatingPoint} />
				</Col>
			</Row>
			<Form.Item {...tailLayout}>
				<Button type="primary" htmlType="submit" style={{ marginRight: 8 }}>
					<SaveOutlined /> Save
				</Button>
				<Popconfirm title="Delete this server? Fan control is handed back to the iDRAC first." okText="Delete" okButtonProps={{ danger: true }} onConfirm={onDelete}>
					<Button danger>
						<DeleteOutlined /> Delete
					</Button>
				</Popconfirm>
			</Form.Item>
		</Form>
	)
}
