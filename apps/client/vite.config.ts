import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    host: true,
    // Allow tunneled hosts (playit.gg, etc.) through Vite's host check.
    allowedHosts: [".tun.ply.gg"],
    proxy: {
      // Forward API/WebSocket to the authoritative server during dev.
      "/health": "http://localhost:8080",
      "/ws": { target: "ws://localhost:8080", ws: true },
    },
  },
});
