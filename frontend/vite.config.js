import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/auth": "http://localhost:4000",
      "/files": "http://localhost:4000",
      "/public": "http://localhost:4000",
      "/folders": "http://localhost:4000",
      "/admin": "http://localhost:4000",
    },
  },
});
