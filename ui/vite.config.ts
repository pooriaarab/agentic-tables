import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The UI uses the typed client of this package. The client has type-only imports, so the alias pulls in no Node code.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  resolve: { alias: { "agentic-tables/client": fileURLToPath(new URL("../src/client.ts", import.meta.url)) } },
  build: { outDir: fileURLToPath(new URL("../ui-dist", import.meta.url)), emptyOutDir: true },
});
