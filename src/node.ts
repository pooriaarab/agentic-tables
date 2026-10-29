// The tables HTTP API on Node, over any `Store` from agentic-identity. It holds no storage code: pass a
// Firestore, D1-over-HTTP, memory, or file store. The caller comes from headers, as in the Worker, so the
// server refuses to start unless you accept that with `unsafeNoAuth: true`. Use it for local work only.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createSharing, type Store } from "agentic-identity";
import { createUnsafeApp } from "./app.js";
import { createTables } from "./tables.js";

export interface NodeServerOptions {
  store: Store;
  /** Required. Nothing checks who calls yet. */
  unsafeNoAuth: true;
  /** Default 127.0.0.1. */
  host?: string;
  /** Default 8787. Use 0 for any free port. */
  port?: number;
}

export interface RunningNodeServer {
  /** The base URL of the tables API, with no trailing slash. */
  url: string;
  close(): Promise<void>;
}

async function toRequest(req: IncomingMessage, origin: string): Promise<Request> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  const chunks: Buffer[] = [];
  if (hasBody) for await (const chunk of req) chunks.push(chunk as Buffer);
  return new Request(new URL(req.url ?? "/", origin), { method, headers, body: hasBody ? Buffer.concat(chunks) : undefined });
}

export async function createNodeServer(options: NodeServerOptions): Promise<RunningNodeServer> {
  if (options.unsafeNoAuth !== true) throw new Error("set unsafeNoAuth: true. This server has no authentication yet");
  const app = createUnsafeApp(createTables(options.store), createSharing(options.store));
  const host = options.host ?? "127.0.0.1";
  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        const response = await app.fetch(await toRequest(req, `http://${host}`));
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "INTERNAL", message: "unexpected error" } }));
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8787, host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  return {
    url: `http://${host}:${port}/api/v1/tables`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
