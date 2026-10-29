import React, { useEffect, useState } from "react"
import "antd/dist/antd.css"
import { Button, Card, Layout, Menu, Tabs, Tag } from "antd"
import { LaptopOutlined, PlusOutlined, SettingOutlined } from "@ant-design/icons"
import { socket } from "./api"
import ServerOverview from "./components/ServerOverview"
import ServerForm from "./components/ServerForm"
import AddServerModal from "./components/AddServerModal"

const { Content, Sider } = Layout

function getValue(key) {
	try {
		return JSON.parse(localStorage[key])
	} catch (e) {
		return undefined
	}
}
function setValue(key, value) {
	localStorage[key] = JSON.stringify(value)
}

function useConnected() {
	const [connected, setConnected] = useState(socket.connected)
	useEffect(() => {
		const up = () => setConnected(true)
		const down = () => setConnected(false)
		socket.on("connect", up)
		socket.on("disconnect", down)
		setConnected(socket.connected)
		return () => {
			socket.off("connect", up)
			socket.off("disconnect", down)
		}
	}, [])
	return connected
}

function App() {
	const [servers, setServers] = useState([])
	const [selectedKeys, setSelectedKeys] = useState(() => getValue("selectedKeys") || [])
	const [activeTab, setActiveTab] = useState()
	const [adding, setAdding] = useState(false)
	const connected = useConnected()

	useEffect(() => {
		const onServers = (list) => setServers(list)
		const onSensordata = (data) =>
			setServers((prev) => prev.map((s) => (s.id === data.id ? { ...s, name: data.name ?? s.name, sensordata: data.sensordata, status: data.status } : s)))
		socket.on("servers", onServers)
		socket.on("sensordata", onSensordata)
		return () => {
			socket.off("servers", onServers)
			socket.off("sensordata", onSensordata)
		}
	}, [])

	// Saved selections from before servers had ids hold iDRAC addresses; fall back to showing every server
	useEffect(() => {
		if (servers.length && !selectedKeys.some((key) => key === "admin" || servers.some((server) => server.id === key))) {
			setSelectedKeys(servers.map((server) => server.id))
		}
	}, [servers.length]) // eslint-disable-line react-hooks/exhaustive-deps

	const select = ({ selectedKeys }) => {
		setSelectedKeys(selectedKeys)
		setValue("selectedKeys", selectedKeys)
	}

	const visible = servers.filter((x) => selectedKeys.includes(x.id))
	const currentTab = servers.some((x) => x.id === activeTab) ? activeTab : servers[0]?.id

	const items = [
		{ key: "servers", icon: <LaptopOutlined />, label: "Servers", children: servers.map((server) => ({ key: server.id, label: server.name })) },
		{ key: "admin", icon: <SettingOutlined />, label: "Admin" },
	]

	return (
		<Layout style={{ height: "100%" }}>
			<Layout>
				<Sider width={200} className="site-layout-background">
					<div style={{ padding: "12px 16px" }}>
						<Tag color={connected ? "green" : "red"}>{connected ? "Connected" : "Disconnected"}</Tag>
					</div>
					<Menu
						multiple
						mode="inline"
						items={items}
						selectedKeys={selectedKeys}
						defaultOpenKeys={["servers"]}
						style={{ borderRight: 0 }}
						onSelect={select}
						onDeselect={select}
					/>
				</Sider>
				<Layout>
					<Content className="site-layout-background" style={{ padding: 0, margin: 0, minHeight: 280 }}>
						{visible.map((server) => (
							<ServerOverview key={server.id} server={server} />
						))}
						{selectedKeys.includes("admin") && (
							<Card
								title="Admin"
								extra={
									<Button type="primary" onClick={() => setAdding(true)}>
										<PlusOutlined /> Add server
									</Button>
								}
							>
								<Tabs
									activeKey={currentTab}
									onChange={setActiveTab}
									items={servers.map((server) => ({ key: server.id, label: server.name, children: <ServerForm server={server} /> }))}
								/>
							</Card>
						)}
					</Content>
				</Layout>
			</Layout>
			<AddServerModal open={adding} onClose={() => setAdding(false)} />
		</Layout>
	)
}

export default App
