// End to end: the Node server over the Store port. The same API suite as the Worker runs on the memory
// store always, and on the Firestore store when FIRESTORE_EMULATOR_HOST is set (CI starts the emulator).
import { createMemoryStore, type Store } from "agentic-identity";
import { createFirestoreStore } from "agentic-identity/firestore";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { emulatorFetch } from "./emulator-fetch.js";
import { defineApiSuite } from "./api-suite.js";
import { createNodeServer, type RunningNodeServer } from "./node.js";

const emulator = process.env.FIRESTORE_EMULATOR_HOST;
const targets: { title: string; store: () => Store }[] = [
  { title: "tables Node server on the memory store", store: () => createMemoryStore({ region: "eu" }) },
  ...(emulator
    ? [{ title: "tables Node server on the Firestore emulator", store: () => createFirestoreStore({ projectId: "agentic-tables-e2e", fetch: emulatorFetch(), baseUrl: `http://${emulator}`, region: "eu" }) }]
    : []),
];

// The emulator is much slower than memory: each row is a transaction over HTTP.
if (emulator) vi.setConfig({ testTimeout: 120_000 });

for (const target of targets) {
  let server: RunningNodeServer;
  beforeAll(async () => {
    server = await createNodeServer({ store: target.store(), unsafeNoAuth: true, port: 0 });
  });
  afterAll(() => server.close());
  defineApiSuite({ title: target.title, base: () => server.url });
}

describe("tables Node server setup", () => {
  test("refuses to start without unsafeNoAuth", async () => {
    await expect(createNodeServer({ store: createMemoryStore({ region: "eu" }), port: 0 } as never)).rejects.toThrow(/unsafeNoAuth/);
  });
});
