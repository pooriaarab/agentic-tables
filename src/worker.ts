import { Hono, type Context } from "hono";
import { errorBody } from "./errors.js";
import { PRINCIPAL_KINDS, TablesError, type Actor, type FieldInput, type PrincipalKind, type Values } from "./model.js";
import { createTables, type AddFieldInput, type ChangeTypeOptions, type Tables, type ViewInput } from "./tables.js";
import { createMemoryStore } from "./store.js";
import { MAX_BODY_BYTES, schemas } from "./schemas.js";
import type { ZodTypeAny, z } from "zod";

const STATUS: Record<string, 400 | 401 | 404 | 409 | 413 | 422> = {
  UNAUTHENTICATED: 401,
  PAYLOAD_TOO_LARGE: 413,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 422,
  SCAN_LIMIT: 422,
  MIGRATION_ABORTED: 409,
};

// The actor comes from headers. Nothing checks these headers yet, so the
// Worker must not face the public internet until the identity port lands.
// The default export refuses to serve unless AGENTIC_TABLES_UNSAFE_NO_AUTH=1.
function actorOf(c: Context): Actor {
  const id = c.req.header("x-principal-id") ?? "";
  const kind = c.req.header("x-principal-kind") as PrincipalKind;
  if (id === "" || !PRINCIPAL_KINDS.includes(kind)) {
    throw new TablesError("UNAUTHENTICATED", `send x-principal-id and x-principal-kind (one of ${PRINCIPAL_KINDS.join(", ")})`);
  }
  return { id, kind };
}

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

export function createApp(tables: Tables) {
  const api = new Hono().basePath("/api/v1/tables");

  api.onError((error, c) => {
    if (error instanceof TablesError) return c.json(errorBody(error), STATUS[error.code] ?? 400);
    return c.json({ error: { code: "INTERNAL", message: "unexpected error" } }, 500);
  });
  api.notFound((c) => c.json({ error: { code: "NOT_FOUND", message: "no such route" } }, 404));

  api.post("/bases", async (c) => c.json(await tables.createBase((await jsonBody(c, schemas.createBase)).name), 201));
  api.get("/bases", async (c) => c.json({ items: await tables.listBases() }));

  api.post("/bases/:baseId/tables", async (c) => {
    const body = await jsonBody(c, schemas.createTable);
    return c.json(await tables.createTable(c.req.param("baseId"), body.name, (body.fields ?? []) as FieldInput[]), 201);
  });
  api.get("/bases/:baseId/tables", async (c) => c.json({ items: await tables.listTables(c.req.param("baseId")) }));
  api.get("/tables/:tableId", async (c) => c.json(await tables.getTable(c.req.param("tableId"))));

  api.post("/tables/:tableId/fields", async (c) => c.json(await tables.addField(c.req.param("tableId"), (await jsonBody(c, schemas.addField)) as AddFieldInput), 201));
  api.patch("/tables/:tableId/fields/:field", async (c) =>
    c.json(await tables.renameField(c.req.param("tableId"), c.req.param("field"), (await jsonBody(c, schemas.renameField)).name)),
  );
  api.delete("/tables/:tableId/fields/:field", async (c) => c.json(await tables.deleteField(c.req.param("tableId"), c.req.param("field"))));
  api.post("/tables/:tableId/fields/:field/type", async (c) =>
    c.json(await tables.changeFieldType(c.req.param("tableId"), c.req.param("field"), (await jsonBody(c, schemas.changeType)) as ChangeTypeOptions)),
  );

  // Body: { values } for one row, or { rows: [values, ...] } for an all-or-nothing batch.
  api.post("/tables/:tableId/rows", async (c) => {
    const actor = actorOf(c);
    const body = await jsonBody(c, schemas.insertRows);
    const tableId = c.req.param("tableId");
    if (body.rows) return c.json({ items: await tables.insertRows(tableId, body.rows as Values[], actor) }, 201);
    return c.json(await tables.insertRow(tableId, (body.values ?? {}) as Values, actor), 201);
  });
  // Query: filter (JSON), sort (Field or Field:desc), limit, cursor.
  api.get("/tables/:tableId/rows", async (c) => {
    const [field = "", direction] = (c.req.query("sort") ?? "").split(":");
    return c.json(
      await tables.queryRows(c.req.param("tableId"), {
        filter: jsonParam(c, "filter") as never,
        sort: field ? { field, direction: direction === "desc" ? "desc" : "asc" } : undefined,
        ...pageOf(c),
      }),
    );
  });
  api.get("/rows/:rowId", async (c) => c.json(await tables.getRow(c.req.param("rowId"))));
  api.patch("/rows/:rowId", async (c) => c.json(await tables.updateRow(c.req.param("rowId"), ((await jsonBody(c, schemas.updateRow)).values as Values), actorOf(c))));
  api.delete("/rows/:rowId", async (c) => {
    actorOf(c);
    await tables.deleteRow(c.req.param("rowId"));
    return c.json({ deleted: c.req.param("rowId") });
  });

  api.post("/tables/:tableId/views", async (c) => c.json(await tables.createView(c.req.param("tableId"), (await jsonBody(c, schemas.createView)) as ViewInput), 201));
  api.get("/tables/:tableId/views", async (c) => c.json({ items: await tables.listViews(c.req.param("tableId")) }));
  api.get("/views/:viewId/rows", async (c) => c.json(await tables.runView(c.req.param("viewId"), pageOf(c))));
  api.delete("/views/:viewId", async (c) => {
    await tables.deleteView(c.req.param("viewId"));
    return c.json({ deleted: c.req.param("viewId") });
  });

  return api;
}

// The in-memory store lasts as long as one Worker instance. A durable adapter replaces it later.
let app: ReturnType<typeof createApp> | undefined;

// Nothing checks who calls yet. The Worker refuses every request until the operator opts in.
export default {
  fetch(request: Request, env: { AGENTIC_TABLES_UNSAFE_NO_AUTH?: string } = {}): Response | Promise<Response> {
    if (env.AGENTIC_TABLES_UNSAFE_NO_AUTH !== "1") {
      return Response.json(
        { error: { code: "UNSAFE_NOT_ENABLED", message: "this Worker has no authentication yet. Set AGENTIC_TABLES_UNSAFE_NO_AUTH=1 for local use only" } },
        { status: 503 },
      );
    }
    return (app ??= createApp(createTables(createMemoryStore()))).fetch(request);
  },
};
