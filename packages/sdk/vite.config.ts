import { defineConfig } from "vite";

// Standalone browser bundle for the script-tag install path:
//   <script type="module">import { init } from "/voice-bug.js"; init({ port, token })</script>
export default defineConfig({
  build: {
    lib: { entry: "src/index.ts", formats: ["es"], fileName: () => "voice-bug.js" },
    outDir: "dist",
    sourcemap: true,
  },
});
