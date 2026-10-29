import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

// The notices of the code and fonts that the app bundles. The text comes from the packages that ship it, so it stays current.
function notices(): Plugin {
  const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
  return {
    name: "tables-notices",
    generateBundle() {
      const parts = [
        "# Third-party notices\n\nThe app in this folder bundles the code and fonts below. Each one keeps its own license.\n",
        `## agentic-design and the packages it bundles\n\n${read("../node_modules/agentic-design/dist/THIRD_PARTY_LICENSES.md")}`,
        ...["react", "react-dom", "scheduler"].map((name) => `## ${name}\n\n${read(`../node_modules/${name}/LICENSE`)}`),
        `## Fonts\n\n${read("../node_modules/agentic-design/dist/fonts/OFL-Inter.txt")}\n${read("../node_modules/agentic-design/dist/fonts/OFL-JetBrainsMono.txt")}`,
      ];
      this.emitFile({ type: "asset", fileName: "THIRD_PARTY_NOTICES.md", source: parts.join("\n") });
    },
  };
}

// The UI uses the typed client of this package. The client has type-only imports, so the alias pulls in no Node code.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), notices()],
  resolve: { alias: { "agentic-tables/client": fileURLToPath(new URL("../src/client.ts", import.meta.url)) } },
  build: { outDir: fileURLToPath(new URL("../ui-dist", import.meta.url)), emptyOutDir: true },
});
