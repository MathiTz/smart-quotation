import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const apiPort = process.env.API_PORT ?? "8787";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      // Vite and Hono are two processes in dev. SSE needs the proxy to stay
      // open, so buffering is off for the stream route.
      "/api": {
        target: `http://localhost:${apiPort}`,
        changeOrigin: true,
        ws: false,
      },
      // The OpenAPI spec and its viewer are mounted at the API root rather than
      // under /api, so they need proxying by name for the sidebar link to work.
      "/docs": { target: `http://localhost:${apiPort}`, changeOrigin: true },
      "/openapi.json": { target: `http://localhost:${apiPort}`, changeOrigin: true },
    },
  },
  build: { outDir: "dist", sourcemap: true },
});
