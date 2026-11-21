/**
 * Bun test preload plugin to handle Vite's `?worker&url` / `?url` query imports
 * when executing engine modules directly under `bun test` (outside Vite).
 */
import { mock } from "bun:test";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Explicit URL mocks avoid Bun's transitive virtual-namespace resolution bug.
// These CPU-only tests do not execute worklets; Chromium tests use real modules.
const worklets = new URL("../src/engine/worklet/", import.meta.url);
for (const name of readdirSync(worklets)) {
  if (!name.endsWith(".ts")) continue;
  mock.module(`${fileURLToPath(new URL(name, worklets))}?worker&url`, () => ({ default: name }));
}
