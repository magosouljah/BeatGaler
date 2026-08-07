import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(async ({ command }) => ({
  plugins: [react()],
  base: command === "serve" ? "/" : "./",
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: [
        "**/src-tauri/**",
        "**/.vs/**",           // ← Add this line
        "**/node_modules/**"   // Good to have as well
      ],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target: process.env.TAURI_ENV_PLATFORM == "windows"
      ? "chrome105"
      : "safari13",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
}));
