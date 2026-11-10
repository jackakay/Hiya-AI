import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");
// `--production`: minified, no source maps (used when packaging the .vsix).
const production = process.argv.includes("--production");

const ctx = await esbuild.context({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: !production,
  minify: production,
  // vscode is provided by the host; ws's native addons are optional.
  external: ["vscode", "bufferutil", "utf-8-validate"],
  logLevel: "info",
});

if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
