import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.PORT) || 3000,
    host: true,
  },
  build: {
    target: "esnext",
  },
  resolve: {
    alias: {
      "~/game": resolve(__dirname, "src/default"),
    },
  },
});
