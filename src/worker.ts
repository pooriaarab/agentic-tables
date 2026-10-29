import { assertRegion, createSharing, createStoreAuth, parseRegion } from "agentic-identity";
import { createD1Store, D1_SCHEMA, type D1Like } from "agentic-identity/cloudflare";
import { createApp, loggable } from "./app.js";
import { createTables } from "./tables.js";
import pkg from "../package.json" with { type: "json" };

export { createApp };
export type { AppOptions } from "./app.js";

export interface Env {
  /** The D1 database. Create it in the EU: `wrangler d1 create agentic-tables --location weur`. */
  DB?: D1Like;
  /** Where the database lives, as a claim: "eu" or "us". The adapter checks the region D1 reports for each query. */
  AGENTIC_TABLES_REGION?: string;
  /**
   * "1" for `wrangler dev` only. Local D1 reports no region, so a query that reports none counts as served in the declared one.
   * It does not change who may call: every request still needs a credential.
   */
  AGENTIC_TABLES_LOCAL_DEV?: string;
  /** Origins that may send a write with a session cookie, comma separated. A bearer token needs none. */
  AGENTIC_TABLES_ORIGINS?: string;
}

class ConfigError extends Error {}

const LOCAL_SERVED_BY = { eu: "WEUR", us: "WNAM" } as const;

/**
 * The D1 adapter checks the region that D1 reports for each query. `wrangler dev` reports none, so no
 * local run could pass. In local mode only (`AGENTIC_TABLES_LOCAL_DEV=1`), a query that reports no region gets the declared one.
 * A region that D1 does report is never changed.
 */
export function reportingRegion(db: D1Like, region: "eu" | "us"): D1Like {
  const inner = new WeakMap<object, ReturnType<D1Like["prepare"]>>();
  const wrap = (statement: ReturnType<D1Like["prepare"]>): ReturnType<D1Like["prepare"]> => {
    const wrapped: ReturnType<D1Like["prepare"]> = {
      bind: (...values) => wrap(statement.bind(...values)),
      first: <T>() => statement.first<T>(),
      all: async <T>() => {
        const answer = await statement.all<T>();
        return { ...answer, meta: { ...answer.meta, served_by_region: answer.meta?.served_by_region ?? LOCAL_SERVED_BY[region] } };
      },
      run: () => statement.run(),
    };
    inner.set(wrapped, statement);
    return wrapped;
  };
  return { prepare: (sql) => wrap(db.prepare(sql)), batch: (statements) => db.batch(statements.map((s) => inner.get(s) ?? s)) };
}

/** Open the store once per Worker instance. A bad setup fails here, before any request reads or writes. */
async function open(env: Env) {
  if (!env.DB) throw new ConfigError("bind a D1 database as DB");
  let region;
  try {
    region = parseRegion(env.AGENTIC_TABLES_REGION);
  } catch {
    region = "unknown" as const;
  }
  if (region === "unknown") throw new ConfigError('set AGENTIC_TABLES_REGION to "eu" or "us"');
  const store = createD1Store(env.AGENTIC_TABLES_LOCAL_DEV === "1" ? reportingRegion(env.DB, region) : env.DB, { region });
  assertRegion(region, store);
  await env.DB.prepare(D1_SCHEMA).run();
  const origins = (env.AGENTIC_TABLES_ORIGINS ?? "").split(",").map((o) => o.trim()).filter((o) => o !== "");
  // Credentials and principals live in the same store as the data. Issue them with `issueCredential` from agentic-identity.
  return createApp(createTables(store), createSharing(store), createStoreAuth(store), { origins });
}

let app: ReturnType<typeof open> | undefined;

// Every request except `GET /health` needs a credential that `agentic-identity` verifies. A request with none gets 401, before any route runs.
export default {
  async fetch(request: Request, env: Env = {}): Promise<Response> {
    // Liveness. It needs no credential and no database, so it answers even when the Worker is not set up yet.
    if (request.method === "GET" && new URL(request.url).pathname === "/health") return Response.json({ ok: true, name: pkg.name, version: pkg.version });
    let ready: Awaited<ReturnType<typeof open>>;
    try {
      ready = await (app ??= open(env));
    } catch (error) {
      app = undefined;
      if (error instanceof ConfigError) return Response.json({ error: { code: "MISCONFIGURED", message: error.message } }, { status: 500 });
      console.error(JSON.stringify({ level: "error", message: loggable(error) }));
      return Response.json({ error: { code: "UNAVAILABLE", message: "the database is not ready. Try again" } }, { status: 503 });
    }
    return ready.fetch(request);
  },
};
