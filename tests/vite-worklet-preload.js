// Test-only Vite asset URL adapter. No audio/DSP modules are mocked.
// Production Vite transforms these five imports to real AudioWorklet assets;
// Bun's unit-test runtime has no Vite worker URL loader.
// Actual audio worklets are verified separately against the production build.
import { mock } from "bun:test";
import { fileURLToPath } from "node:url";
for (const name of ["analog", "sy1", "strings", "fm", "vector"]) {
  const path = fileURLToPath(new URL("../src/engine/worklet/" + name + "-processor.ts", import.meta.url));
  mock.module(path + "?worker&url", () => ({ default: path }));
}
