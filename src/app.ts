import { assertId, type Auth, type PrincipalContext, type Role, type SubjectKind } from "agentic-identity";
import { requirePrincipal } from "agentic-identity/http";
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
  ERASE_INCOMPLETE: 409,
  PAYLOAD_TOO_LARGE: 413,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 422,
  SCAN_LIMIT: 422,
  MIGRATION_ABORTED: 409,
};

/** Find the caller of a request, or answer for it. `createApp` uses a real `Auth`. `createUnsafeApp` trusts headers. */
type Authenticate = (request: Request) => Promise<PrincipalContext | Response>;

const REFUSALS: Record<number, { code: string; message: string }> = {
  401: { code: "UNAUTHENTICATED", message: "send a valid credential as Authorization: Bearer <token>" },
  403: { code: "FORBIDDEN", message: "this credential is not allowed to do this" },
};

/** Give a refusal from `requirePrincipal` the error body of this API. Its status and `www-authenticate` stay. */
function refusal(response: Response): Response {
  const body = REFUSALS[response.status] ?? { code: "UNAVAILABLE", message: "sign-in is not available. Try again" };
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  const challenge = response.headers.get("www-authenticate");
  if (challenge) headers.set("www-authenticate", challenge);
  return new Response(JSON.stringify({ error: body }), { status: response.status, headers });
}

export interface AppOptions {
  /**
   * Origins that may send a write with a session cookie, such as `https://tables.example.com`. A bearer token needs none.
   * A cookie write from any other origin is refused with 403.
   */
  origins?: readonly string[];
}

/** Credentials are checked by `agentic-identity`. Each route then checks the scope of the credential for its action. */
const verified = (auth: Auth, options: AppOptions): Authenticate => async (request) => {
  const found = await requirePrincipal(request, auth, { origins: options.origins });
  return found instanceof Response ? refusal(found) : found;
};

/** Nothing proves these headers. Local work and tests only. */
const trusted: Authenticate = async (request) => {
  try {
    return await callerFromHeaders((name) => request.headers.get(name) ?? undefined);
  } catch (error) {
    if (error instanceof TablesError) return refusal(new Response(null, { status: 401 }));
    throw error;
  }
};

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
export const loggable = (error: unknown): string => (error instanceof Error ? (LOGGABLE.exec(error.message)?.[0] ?? error.name) : "unknown");

/**
 * The HTTP API. `auth` reads the credential of each request (`createStoreAuth` from `agentic-identity` for a Worker).
 * A request with no valid credential gets 401. A credential without the scope of a route gets 403.
 */
export function createApp(tables: Tables, sharing: Sharing, auth: Auth, options: AppOptions = {}) {
  if (typeof auth?.authenticate !== "function") throw new TypeError("createApp needs an Auth as its third argument, such as createStoreAuth(store)");
  return build(tables, sharing, verified(auth, options));
}

/** The API with the caller read from `x-principal-*` headers that nothing checks. For a server on this machine and for tests. */
export function createUnsafeApp(tables: Tables, sharing: Sharing) {
  return build(tables, sharing, trusted);
}

function build(tables: Tables, sharing: Sharing, authenticate: Authenticate) {
  const guard = createGuarded(tables, sharing);
  const api = new Hono<{ Variables: { caller: PrincipalContext } }>().basePath("/api/v1/tables");
  // Every route needs a caller, so nothing below runs without one.
  api.use("*", async (c, next) => {
    const found = await authenticate(c.req.raw);
    if (found instanceof Response) return found;
    c.set("caller", found);
    await next();
  });
  /** The API of Tables for the caller of this request. It checks the scope and the role. */
  const as = async (c: Context) => guard(c.get("caller") as PrincipalContext);

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
    // The subject is a kind (`human` or `agent`) and an id: a person and an agent with one id hold separate roles.
    const subjectOf = (c: Context) => ({ kind: c.req.param("subjectKind") as SubjectKind, id: c.req.param("subjectId") as string });
    api.put(`/${kind}/members/:subjectKind/:subjectId`, async (c) => {
      const g = await as(c);
      const { role } = await jsonBody(c, schemas.grant);
      await g.grant(type, idParam(c, param), subjectOf(c), role as Role);
      return c.json({ resourceId: idParam(c, param), subjectKind: subjectOf(c).kind, subjectId: subjectOf(c).id, role });
    });
    api.delete(`/${kind}/members/:subjectKind/:subjectId`, async (c) => {
      await (await as(c)).revokeGrant(type, idParam(c, param), subjectOf(c));
      return c.json({ resourceId: idParam(c, param), subjectKind: subjectOf(c).kind, subjectId: subjectOf(c).id });
    });
  }

  return api;
}
