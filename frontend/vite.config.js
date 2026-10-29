import { defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react"

export default defineConfig({
	plugins: [react()],
	server: {
		port: 3000,
		strictPort: true,
		proxy: {
			"/socket.io": {
				target: "http://localhost:8082",
				changeOrigin: true,
				ws: true,
			},
		},
	},
	build: {
		target: "es2018",
		outDir: "build",
		emptyOutDir: true,
		// antd 4 alone is ~600 kB; this is a LAN-only app served from disk
		chunkSizeWarningLimit: 1500,
	},
	test: {
		environment: "jsdom",
		globals: true,
		setupFiles: ["./src/setupTests.js"],
	},
})
