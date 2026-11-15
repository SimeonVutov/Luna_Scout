import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Set LUNASCOUT_API_URL to run the website against an API on another port.
const proxy = { "/api": process.env.LUNASCOUT_API_URL ?? "http://127.0.0.1:8000" };

export default defineConfig({
  plugins: [react()],
  server: { proxy },
  preview: { proxy },
});
