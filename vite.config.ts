import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(async ({ command, mode }) => ({
  plugins: [react()],
  base: command === "serve" ? "/" : "./",
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: [
        "**/src-tauri/**",
        "**/.vs/**",
        "**/node_modules/**"
      ],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    // Web transport dependencies use native BigInt. The browser build therefore
    // targets ES2020, while Desktop keeps its existing platform-specific targets.
    target: mode === "web"
      ? "es2020"
      : process.env.TAURI_ENV_PLATFORM == "windows"
        ? "chrome105"
        : "safari13",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
}));
