import { assertId, assertRegion, createSharing, parseRegion, type Role } from "agentic-identity";
import { createD1Store, D1_SCHEMA, type D1Like } from "agentic-identity/cloudflare";
import { Hono, type Context } from "hono";
import { errorBody } from "./errors.js";
import { callerFromHeaders } from "./caller.js";
import { createGuarded, type Sharing } from "./guarded.js";
import { TablesError, type FieldInput, type Values } from "./model.js";
import { createTables, type AddFieldInput, type ChangeTypeOptions, type Tables, type ViewInput } from "./tables.js";
import { MAX_BODY_BYTES, schemas } from "./schemas.js";
import type { ZodTypeAny, z } from "zod";

const STATUS: Record<string, 400 | 401 | 403 | 404 | 409 | 413 | 422> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  LEGACY_BASE: 409,
  PAYLOAD_TOO_LARGE: 413,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 422,
  SCAN_LIMIT: 422,
  MIGRATION_ABORTED: 409,
};

// The caller comes from headers. Nothing checks these headers yet, so the Worker must not face the public
// internet until the identity port lands. The default export refuses to serve unless AGENTIC_TABLES_UNSAFE_NO_AUTH=1.
const contextOf = (c: Context) => callerFromHeaders((name) => c.req.header(name));

/** Read a body with a size cap, then check it against a schema. Both failures are client errors. */
async function jsonBody<S extends ZodTypeAny>(c: Context, schema: S): Promise<z.infer<S>> {
  const declared = Number(c.req.header("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) throw new TablesError("PAYLOAD_TOO_LARGE", `the body must be at most ${MAX_BODY_BYTES} bytes`);
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.byteLength > MAX_BODY_BYTES) throw new TablesError("PAYLOAD_TOO_LARGE", `the body must be at most ${MAX_BODY_BYTES} bytes`);
  const text = new TextDecoder().decode(bytes);
  let body: unknown;
  try {
    body = text.trim() === "" ? {} : JSON.parse(text);
  } catch {
    throw new TablesError("BAD_REQUEST", "the body must be a JSON object");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new TablesError("BAD_REQUEST", "the body must be a JSON object");
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
    throw new TablesError("BAD_REQUEST", `the body is not valid. ${detail}`);
  }
  return parsed.data;
}

/** A path id the store would refuse is a missing resource. The store error text holds the id, so it never reaches a log. */
function idParam(c: Context, name: string): string {
  const value = c.req.param(name) ?? "";
  try {
    assertId(value);
  } catch {
    throw new TablesError("NOT_FOUND", "no such resource");
  }
  return value;
}

function jsonParam(c: Context, name: string): unknown {
  const text = c.req.query(name);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new TablesError("BAD_REQUEST", `${name} must be JSON`);
  }
}

function pageOf(c: Context): { limit?: number; cursor?: string } {
  const limit = c.req.query("limit");
  return { ...(limit === undefined ? {} : { limit: Number(limit) }), cursor: c.req.query("cursor") };
}

/**
 * What may reach a log: the known store failures, cut short. Any other message could hold a caller's
 * input, such as an id or an email address, so it is never written.
 */
const LOGGABLE = /^(D1_ERROR[^"]{0,150}|transaction kept conflicting after \d+ attempts|transaction kept conflicting|the database served a query from \w+)/;
const loggable = (error: unknown): string => (error instanceof Error ? (LOGGABLE.exec(error.message)?.[0] ?? error.name) : "unknown");

export function createApp(tables: Tables, sharing: Sharing) {
  const guard = createGuarded(tables, sharing);
  /** The API of Tables for the caller of this request. It checks the headers and the role. */
  const as = async (c: Context) => guard(await contextOf(c));
  const api = new Hono().basePath("/api/v1/tables");

  api.onError((error, c) => {
    if (error instanceof TablesError) return c.json(errorBody(error), STATUS[error.code] ?? 400);
    console.error(JSON.stringify({ level: "error", message: loggable(error) }));
    return c.json({ error: { code: "INTERNAL", message: "unexpected error" } }, 500);
  });
  api.notFound((c) => c.json({ error: { code: "NOT_FOUND", message: "no such route" } }, 404));

  api.post("/bases", async (c) => {
    const g = await as(c);
    return c.json(await g.createBase((await jsonBody(c, schemas.createBase)).name), 201);
  });
  // Data rights for the caller: export what the caller owns and wrote, or hard delete it.
  api.get("/me/export", async (c) => c.json(await (await as(c)).exportMyData()));
  api.delete("/me/data", async (c) => c.json(await (await as(c)).eraseMyData()));
  api.get("/bases", async (c) => c.json({ items: await (await as(c)).listBases() }));

  api.post("/bases/:baseId/tables", async (c) => {
    const body = await jsonBody(c, schemas.createTable);
    return c.json(await (await as(c)).createTable(idParam(c, "baseId"), body.name, (body.fields ?? []) as FieldInput[]), 201);
  });
  api.get("/bases/:baseId/tables", async (c) => c.json({ items: await (await as(c)).listTables(idParam(c, "baseId")) }));
  api.delete("/bases/:baseId", async (c) => c.json(await (await as(c)).deleteBase(idParam(c, "baseId"))));
  api.delete("/tables/:tableId", async (c) => c.json(await (await as(c)).deleteTable(idParam(c, "tableId"))));
  api.get("/tables/:tableId", async (c) => c.json(await (await as(c)).getTable(idParam(c, "tableId"))));

  api.post("/tables/:tableId/fields", async (c) => c.json(await (await as(c)).addField(idParam(c, "tableId"), (await jsonBody(c, schemas.addField)) as AddFieldInput), 201));
  api.patch("/tables/:tableId/fields/:field", async (c) =>
    c.json(await (await as(c)).renameField(idParam(c, "tableId"), c.req.param("field"), (await jsonBody(c, schemas.renameField)).name)),
  );
  api.delete("/tables/:tableId/fields/:field", async (c) => c.json(await (await as(c)).deleteField(idParam(c, "tableId"), c.req.param("field"))));
  api.put("/tables/:tableId/fields/:field/required", async (c) => {
    const body = await jsonBody(c, schemas.setRequired);
    return c.json(await (await as(c)).setRequired(idParam(c, "tableId"), c.req.param("field"), body.required, { dryRun: body.dryRun === true }));
  });
  api.post("/tables/:tableId/fields/:field/type", async (c) =>
    c.json(await (await as(c)).changeFieldType(idParam(c, "tableId"), c.req.param("field"), (await jsonBody(c, schemas.changeType)) as ChangeTypeOptions)),
  );

  // Body: { values } for one row, or { rows: [values, ...] } for an all-or-nothing batch.
  api.post("/tables/:tableId/rows", async (c) => {
    const g = await as(c);
    const body = await jsonBody(c, schemas.insertRows);
    const tableId = idParam(c, "tableId");
    if (body.rows) return c.json({ items: await g.insertRows(tableId, body.rows as Values[]) }, 201);
    return c.json(await g.insertRow(tableId, (body.values ?? {}) as Values), 201);
  });
  // Query: filter (JSON), sort (Field or Field:desc), limit, cursor.
  api.get("/tables/:tableId/rows", async (c) => {
    const [field = "", direction] = (c.req.query("sort") ?? "").split(":");
    return c.json(
      await (await as(c)).queryRows(idParam(c, "tableId"), {
        filter: jsonParam(c, "filter") as never,
        sort: field ? { field, direction: direction === "desc" ? "desc" : "asc" } : undefined,
        ...pageOf(c),
      }),
    );
  });
  api.get("/rows/:rowId", async (c) => c.json(await (await as(c)).getRow(idParam(c, "rowId"))));
  api.patch("/rows/:rowId", async (c) => c.json(await (await as(c)).updateRow(idParam(c, "rowId"), (await jsonBody(c, schemas.updateRow)).values as Values)));
  api.delete("/rows/:rowId", async (c) => {
    await (await as(c)).deleteRow(idParam(c, "rowId"));
    return c.json({ deleted: idParam(c, "rowId") });
  });

  api.post("/tables/:tableId/views", async (c) => c.json(await (await as(c)).createView(idParam(c, "tableId"), (await jsonBody(c, schemas.createView)) as ViewInput), 201));
  api.get("/tables/:tableId/views", async (c) => c.json({ items: await (await as(c)).listViews(idParam(c, "tableId")) }));
  api.get("/views/:viewId/rows", async (c) => c.json(await (await as(c)).runView(idParam(c, "viewId"), pageOf(c))));
  api.delete("/views/:viewId", async (c) => {
    await (await as(c)).deleteView(idParam(c, "viewId"));
    return c.json({ deleted: idParam(c, "viewId") });
  });

  // Make a base from an earlier version usable. The caller must be its owner, by id.
  api.post("/bases/:baseId/claim", async (c) => c.json(await (await as(c)).claimBase(idParam(c, "baseId"))));

  // Roles. The caller must own the base or the table. A role on a base passes down to its tables.
  for (const [kind, type, param] of [["bases/:baseId", "base", "baseId"], ["tables/:tableId", "table", "tableId"]] as const) {
    api.put(`/${kind}/members/:subjectId`, async (c) => {
      const g = await as(c);
      const { role } = await jsonBody(c, schemas.grant);
      await g.grant(type, idParam(c, param), c.req.param("subjectId"), role as Role);
      return c.json({ resourceId: idParam(c, param), subjectId: c.req.param("subjectId"), role });
    });
    api.delete(`/${kind}/members/:subjectId`, async (c) => {
      await (await as(c)).revokeGrant(type, idParam(c, param), c.req.param("subjectId"));
      return c.json({ resourceId: idParam(c, param), subjectId: c.req.param("subjectId") });
    });
  }

  return api;
}

export interface Env {
  /** The D1 database. Create it in the EU: `wrangler d1 create agentic-tables --location weur`. */
  DB?: D1Like;
  /** Where the database lives, as a claim: "eu" or "us". The adapter checks the region D1 reports for each query. */
  AGENTIC_TABLES_REGION?: string;
  AGENTIC_TABLES_UNSAFE_NO_AUTH?: string;
}

class ConfigError extends Error {}

const LOCAL_SERVED_BY = { eu: "WEUR", us: "WNAM" } as const;

/**
 * The D1 adapter checks the region that D1 reports for each query. `wrangler dev` reports none, so no
 * local run could pass. In unsafe local mode only, a query that reports no region gets the declared one.
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
  const store = createD1Store(env.AGENTIC_TABLES_UNSAFE_NO_AUTH === "1" ? reportingRegion(env.DB, region) : env.DB, { region });
  assertRegion(region, store);
  await env.DB.prepare(D1_SCHEMA).run();
  return createApp(createTables(store), createSharing(store));
}

let app: ReturnType<typeof open> | undefined;

// Nothing checks who calls yet. The Worker refuses every request until the operator opts in.
export default {
  async fetch(request: Request, env: Env = {}): Promise<Response> {
    if (env.AGENTIC_TABLES_UNSAFE_NO_AUTH !== "1") {
      return Response.json(
        { error: { code: "UNSAFE_NOT_ENABLED", message: "this Worker has no authentication yet. Set AGENTIC_TABLES_UNSAFE_NO_AUTH=1 for local use only" } },
        { status: 503 },
      );
    }
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
