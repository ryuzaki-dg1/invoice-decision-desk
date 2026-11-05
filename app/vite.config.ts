import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { apiPlugin } from "./server/vitePlugin.ts";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), apiPlugin()],
});
