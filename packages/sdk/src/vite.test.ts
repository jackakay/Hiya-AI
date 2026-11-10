import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveVoiceAsset, voiceAssetDirs } from "./vite";

describe("voice assets", () => {
  const dirs = { "/__voice-bug/vad/": path.resolve("/vad"), "/__voice-bug/ort/": path.resolve("/ort") };

  it("maps plain file names under the known prefixes", () => {
    expect(resolveVoiceAsset("/__voice-bug/vad/silero_vad_v5.onnx", dirs)).toBe(path.join(path.resolve("/vad"), "silero_vad_v5.onnx"));
    expect(resolveVoiceAsset("/__voice-bug/ort/ort-wasm-simd-threaded.mjs?import", dirs)).toBe(path.join(path.resolve("/ort"), "ort-wasm-simd-threaded.mjs"));
  });

  it.each([
    "/__voice-bug/vad/../package.json",
    "/__voice-bug/vad/..%2Fpackage.json",
    "/__voice-bug/vad/sub/file.js",
    "/__voice-bug/vad/.hidden.js",
    "/__voice-bug/vad/readme.md",
    "/__voice-bug/other/x.js",
  ])("refuses %s", (url) => {
    expect(resolveVoiceAsset(url, dirs)).toBeUndefined();
  });

  it("finds the installed VAD model, worklet and ONNX runtime", () => {
    const real = voiceAssetDirs();
    expect(existsSync(path.join(real["/__voice-bug/vad/"]!, "silero_vad_v5.onnx"))).toBe(true);
    expect(existsSync(path.join(real["/__voice-bug/vad/"]!, "vad.worklet.bundle.min.js"))).toBe(true);
    expect(existsSync(path.join(real["/__voice-bug/ort/"]!, "ort-wasm-simd-threaded.wasm"))).toBe(true);
  });
});
