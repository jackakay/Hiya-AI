import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { voiceBug } from "@voice-bug/sdk/vite";

export default defineConfig({
  plugins: [react(), voiceBug()],
});
