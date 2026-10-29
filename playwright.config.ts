import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PLAYWRIGHT_PORT ?? 8791);
const wrangler = fileURLToPath(new URL("./node_modules/wrangler/bin/wrangler.js", import.meta.url));

// The tests run against the real Worker under `wrangler dev`, with a fresh local D1 database each run.
export default defineConfig({
  testDir: "e2e",
  workers: 1,
  fullyParallel: false,
  reporter: "list",
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "retain-on-failure" },
  webServer: {
    command: `rm -rf .wrangler/e2e && node ${wrangler} dev --ip 127.0.0.1 --port ${PORT} --inspector-port ${PORT + 100} --persist-to .wrangler/e2e --var AGENTIC_TABLES_LOCAL_DEV:1 --var AGENTIC_TABLES_REGION:eu`,
    url: `http://127.0.0.1:${PORT}/api/v1/tables/bases`,
    // A 4xx or 5xx still means the Worker answers. Playwright treats 2xx-3xx and 400-403 as ready.
    timeout: 120_000,
    reuseExistingServer: false,
    env: { WRANGLER_SEND_METRICS: "false", CI: "1" },
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
