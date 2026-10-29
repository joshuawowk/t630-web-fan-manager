import React, { useState } from "react"
import { Alert, Form, Input, InputNumber, Modal, message } from "antd"
import { request } from "../api"

export default function AddServerModal({ open, onClose }) {
	const [form] = Form.useForm()
	const [saving, setSaving] = useState(false)
	const [error, setError] = useState(null)

	const close = () => {
		setError(null)
		onClose()
	}

	const submit = async () => {
		let server
		try {
			server = await form.validateFields()
		} catch (e) {
			return
		}
		setSaving(true)
		const result = await request("addServer", { server })
		setSaving(false)
		if (result.ok) {
			message.success("Server added")
			close()
		} else {
			setError(result.error)
		}
	}

	return (
		<Modal title="Add server" open={open} onOk={submit} onCancel={close} okText="Add" confirmLoading={saving} destroyOnClose>
			<Form form={form} preserve={false} layout="vertical" initialValues={{ username: "root", warnspeed: 5000 }}>
				<Form.Item label="Name" name="name" rules={[{ required: true, message: "Please input a server name" }]}>
					<Input />
				</Form.Item>
				<Form.Item label="Address/hostname" name="address" rules={[{ required: true, message: "Please input idrac address/hostname" }]}>
					<Input />
				</Form.Item>
				<Form.Item label="Username" name="username" rules={[{ required: true, message: "Please input idrac username (usually root)" }]}>
					<Input />
				</Form.Item>
				<Form.Item label="Password" name="password" rules={[{ required: true, message: "Please input the idrac password" }]}>
					<Input.Password autoComplete="new-password" />
				</Form.Item>
				<Form.Item label="Warning Speed (RPM)" name="warnspeed" rules={[{ required: true, message: "Please input the fan threshold RPM" }]}>
					<InputNumber min={0} />
				</Form.Item>
				{error && <Alert type="error" showIcon message={error} />}
			</Form>
		</Modal>
	)
}
