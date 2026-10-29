import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const labRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: labRoot,
  plugins: [react()],
  // Separate HTML entry, server and build: never bundle src/main.tsx or app services.
  server: { host: "127.0.0.1", port: 4173, strictPort: true },
  preview: { host: "127.0.0.1", port: 4173, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true, target: "es2020" },
});
