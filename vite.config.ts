import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(async ({ command }) => ({
  plugins: [react()],
  base: command === "serve" ? "/" : "./",
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // Tailscale Serve gives mobile Safari the trusted HTTPS context required
    // by WebCrypto while keeping the development site private to the tailnet.
    allowedHosts: [".ts.net"],
    proxy: {
      // Phones on the same Wi-Fi cannot reach the PC backend through
      // 127.0.0.1 and the backend intentionally rejects arbitrary LAN CORS
      // origins. Keep the development surface same-origin and proxy only the
      // small BeatGaler control-plane requests; media still goes directly
      // between the browser and Telegram.
      "/beatgaler-api": {
        target: "http://127.0.0.1:4000",
        changeOrigin: true,
        rewrite: path => path.replace(/^\/beatgaler-api/, ""),
      },
    },
    watch: {
      ignored: [
        "**/src-tauri/**",
        "**/.vs/**",           // ← Add this line
        "**/node_modules/**"   // Good to have as well
      ],
    },
  },
  preview: {
    port: 1420,
    strictPort: true,
    allowedHosts: [".ts.net"],
    proxy: {
      "/beatgaler-api": {
        target: "http://127.0.0.1:4000",
        changeOrigin: true,
        rewrite: path => path.replace(/^\/beatgaler-api/, ""),
      },
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target: process.env.TAURI_ENV_PLATFORM == "windows"
      ? "chrome105"
      : "safari14",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
}));
