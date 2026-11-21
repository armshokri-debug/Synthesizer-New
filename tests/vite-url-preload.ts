/**
 * Bun test preload plugin to handle Vite's `?worker&url` / `?url` query imports
 * when executing engine modules directly under `bun test` (outside Vite).
 */
import { plugin } from "bun";

plugin({
  name: "vite-worker-url-stub",
  setup(build) {
    build.onResolve({ filter: /\?(worker&url|url)$/ }, (args) => ({
      path: args.path,
      namespace: "vite-url-stub"
    }));
    build.onLoad({ filter: /.*/, namespace: "vite-url-stub" }, (args) => ({
      contents: `export default ${JSON.stringify(args.path)};`,
      loader: "js"
    }));
  }
});
