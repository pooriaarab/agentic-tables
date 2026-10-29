// Start the real Worker under `wrangler dev` for the end-to-end tests. Each Worker takes its own port.
// Workers given the same `persistTo` folder share one local D1 database, as two instances share one D1.
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const WRANGLER = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));

export interface RunningWorker {
  url: string;
  /** The last output of the Worker. */
  log(): string;
  stop(): Promise<void>;
}

export async function startWorker(options: { port: number; persistTo: string; vars?: string[] }): Promise<RunningWorker> {
  const { port, persistTo, vars = [] } = options;
  const args = ["dev", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(port + 100), "--persist-to", persistTo, ...vars.flatMap((v) => ["--var", v])];
  const server: ChildProcess = spawn(process.execPath, [WRANGLER, ...args], {
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  for (const stream of [server.stdout, server.stderr]) stream?.on("data", (chunk: Buffer) => (log = (log + chunk.toString()).slice(-2000)));
  const exited = new Promise<void>((resolve) => server.once("exit", () => resolve()));
  const stop = async () => {
    server.kill("SIGTERM");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
  };
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/v1/tables/bases`);
      return { log: () => log, url: `http://127.0.0.1:${port}/api/v1/tables`, stop };
    } catch {
      if (Date.now() > deadline) {
        await stop();
        throw new Error(`wrangler dev did not start in time. Last output: ${log}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}
