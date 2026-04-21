import { defineConfig } from "vite";

// GitHub project pages live under /<repo>/; set VITE_BASE_PATH in CI (e.g. /395FinalProject/).
const base = process.env.VITE_BASE_PATH || "/";

export default defineConfig({
  base,
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
    },
  },
});
