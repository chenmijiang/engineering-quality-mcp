import { defineConfig } from "vitest/config";

const DECORATOR = /^\s*@[A-Za-z_$]/m;
// Bun's transpiler lowers TC39 decorators like the production runtime; Vite's oxc does not yet.
const transpiler = new Bun.Transpiler({ loader: "ts", target: "bun" });

export default defineConfig({
  plugins: [
    {
      // Mirrors Bun's `with { type: "text" }` imports, which Vite does not understand.
      name: "markdown-as-text",
      enforce: "pre",
      transform(code, id) {
        if (id.endsWith(".md"))
          return { code: `export default ${JSON.stringify(code)};`, map: null };
      },
    },
    {
      // Only decorated modules are rewritten, since stack lines in them shift by the helper prelude.
      name: "bun-decorators",
      enforce: "pre",
      transform(code, id) {
        if (id.endsWith(".ts") && !id.includes("/node_modules/") && DECORATOR.test(code)) {
          return { code: transpiler.transformSync(code), map: null };
        }
      },
    },
  ],
  resolve: { tsconfigPaths: true },
  test: {
    // The default forks pool cannot start under Bun.
    pool: "threads",
  },
});
