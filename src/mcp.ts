import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ROLES, SUBJECT_KINDS } from "agentic-identity";
import { z } from "zod";
import { type Context } from "./context.js";
import { errorBody } from "./errors.js";
import { FIELD_TYPES, type Table, type Values } from "./model.js";
import { OPERATORS } from "./query.js";
import { VERSION } from "./version.js";

const fieldShape = z.object({
  name: z.string(),
  type: z.enum(FIELD_TYPES),
  required: z.boolean().optional(),
  options: z.array(z.string()).optional().describe("Select fields: the allowed values."),
  linkTable: z.string().optional().describe("Link fields: the name or id of the table the rows are in."),
});

const tableRef = z.string().describe("Table name or id.");
const rowId = z.string().describe("Row id, from insert_rows or query_rows.");

const text = (value: unknown, isError = false) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], ...(isError ? { isError: true as const } : {}) });

/** The schema as an agent needs it: each field with the operators a filter may use on it. */
const describe = (table: Table) => ({
  id: table.id,
  name: table.name,
  fields: table.fields.map((f) => ({ ...f, operators: OPERATORS[f.type] })),
});

export function createMcpServer(ctx: Context): McpServer {
  const server = new McpServer({ name: "agentic-tables", version: VERSION });
  // Every tool returns JSON. A failure returns isError with a code, never a success.
  const tool = (name: string, description: string, shape: z.ZodRawShape, kind: "read" | "write" | "delete", fn: (args: any) => Promise<unknown>) =>
    server.registerTool(
      name,
      { description, inputSchema: shape, annotations: { readOnlyHint: kind === "read", destructiveHint: kind === "delete", openWorldHint: false } },
      async (args: any) => {
        try {
          return text(await fn(args));
        } catch (error) {
          return text(errorBody(error).error, true);
        }
      },
    );

  tool("list_bases", "List the bases you can read. Set AGENTIC_TABLES_BASE to work in another base.", {}, "read", async () => ctx.tables.listBases());
  tool("create_base", "Create a base. You own it. Without AGENTIC_TABLES_BASE, your work base is the oldest base you own. A new base becomes the work base only if you own no other base, or when AGENTIC_TABLES_BASE names it and the server restarts.", { name: z.string() }, "write", async ({ name }) => ctx.tables.createBase(name));
  tool("delete_base", "Delete a base with all its tables, rows and views. This cannot be undone. Without AGENTIC_TABLES_BASE, your work base is the oldest base you own: if you delete it, the next oldest becomes the work base, and with none left a new empty base is made. With AGENTIC_TABLES_BASE set, calls fail with NOT_FOUND after the delete.", { baseId: z.string() }, "delete", async ({ baseId }) => ctx.tables.deleteBase(baseId));
  tool("list_tables", "List the tables with their fields.", {}, "read", async () => (await ctx.tables.listTables(await ctx.baseId())).map(describe));
  tool("describe_table", "Read the schema of one table: field names, types, options, required, and the filter operators each field supports. Call this before you write rows.", { table: tableRef }, "read", async ({ table }) => describe(await ctx.table(table)));
  tool("create_table", "Create a table with typed fields.", { name: z.string(), fields: z.array(fieldShape) }, "write", async ({ name, fields }) => {
    const resolved = await Promise.all(fields.map(async (f: z.infer<typeof fieldShape>) => (f.linkTable ? { ...f, linkTable: (await ctx.table(f.linkTable)).id } : f)));
    return describe(await ctx.tables.createTable(await ctx.baseId(), name, resolved));
  });
  tool("add_field", "Add a field. A required field on a table with rows needs a default.", { table: tableRef, field: fieldShape, default: z.any().optional() }, "write", async ({ table, field, default: fill }) => {
    const t = await ctx.table(table);
    return describe(await ctx.tables.addField(t.id, { ...field, ...(field.linkTable ? { linkTable: (await ctx.table(field.linkTable)).id } : {}), ...(fill === undefined ? {} : { default: fill }) }));
  });
  tool("set_required", "Make a field required or optional. Making it required fails and lists the rows that have no value. Use dryRun to see the list first.", { table: tableRef, field: z.string(), required: z.boolean(), dryRun: z.boolean().optional() }, "write", async ({ table, field, required, dryRun }) =>
    ctx.tables.setRequired((await ctx.table(table)).id, field, required, { dryRun }),
  );
  tool("rename_field", "Rename a field. Rows and views keep working.", { table: tableRef, field: z.string(), name: z.string() }, "write", async ({ table, field, name }) => describe(await ctx.tables.renameField((await ctx.table(table)).id, field, name)));
  tool("delete_field", "Delete a field and its values in every row. This cannot be undone.", { table: tableRef, field: z.string() }, "delete", async ({ table, field }) => describe(await ctx.tables.deleteField((await ctx.table(table)).id, field)));
  tool(
    "change_field_type",
    'Change the type of a field. Every value converts or the change fails and lists the rows that fail. Use dryRun to see the report first. onFailure "clear" permanently empties the values that fail.',
    { table: tableRef, field: z.string(), to: z.enum(FIELD_TYPES), options: z.array(z.string()).optional().describe("Select targets. Default: the distinct stored values."), linkTable: z.string().optional(), onFailure: z.enum(["abort", "clear"]).optional(), dryRun: z.boolean().optional() },
    "delete",
    async ({ table, field, linkTable, ...change }) => ctx.tables.changeFieldType((await ctx.table(table)).id, field, { ...change, ...(linkTable !== undefined ? { linkTable: (await ctx.table(linkTable)).id } : {}) }),
  );
  tool("delete_table", "Delete a table with all its rows and views. It fails while another table links to it.", { table: tableRef }, "delete", async ({ table }) => ctx.tables.deleteTable((await ctx.table(table)).id));
  tool("export_my_data", "Export every base owned by the acting principal, with tables, views, and rows, as JSON.", {}, "read", async () => ctx.tables.exportMyData());
  tool("erase_my_data", "Hard delete every base owned by the acting principal. This cannot be undone.", {}, "delete", async () => ctx.tables.eraseMyData());
  tool("claim_base", "Make a base from an earlier version usable. You must be the owner by id. A base with no owner kind blocks export, erase, and new bases until you claim it.", { baseId: z.string() }, "write", ({ baseId }) => ctx.tables.claimBase(baseId));
  tool("share", "Give a person or an agent a role on your base, or on one table. Only an owner can share. A role on the base passes down to its tables.", { subject: z.string().describe("The id of the person or agent."), kind: z.enum(SUBJECT_KINDS).describe("human or agent. A person and an agent can share one id, and hold separate roles."), role: z.enum(ROLES), table: tableRef.optional() }, "write", async ({ subject, kind, role, table }) => {
    const resource = table === undefined ? { type: "base" as const, id: await ctx.baseId() } : { type: "table" as const, id: (await ctx.table(table)).id };
    await ctx.tables.grant(resource.type, resource.id, { kind, id: subject }, role);
    return { resourceId: resource.id, subject, kind, role };
  });
  tool("unshare", "Take a role back from a person or an agent, on your base or on one table. On a base it also takes back the roles on its tables.", { subject: z.string(), kind: z.enum(SUBJECT_KINDS), table: tableRef.optional() }, "delete", async ({ subject, kind, table }) => {
    const resource = table === undefined ? { type: "base" as const, id: await ctx.baseId() } : { type: "table" as const, id: (await ctx.table(table)).id };
    await ctx.tables.revokeGrant(resource.type, resource.id, { kind, id: subject });
    return { resourceId: resource.id, subject, kind };
  });
  tool("insert_rows", "Insert rows. Keys are field names. All rows are checked first. If one fails, none is written, and the error names the row and field.", { table: tableRef, rows: z.array(z.record(z.any())).min(1).max(500) }, "write", async ({ table, rows }) => ({
    rows: await ctx.tables.insertRows((await ctx.table(table)).id, rows as Values[]),
  }));
  tool("update_row", "Change fields of one row. Send only the fields to change. Send null to empty a field.", { rowId, values: z.record(z.any()) }, "write", ({ rowId: id, values }) => ctx.tables.updateRow(id, values as Values));
  tool("delete_row", "Delete one row. It leaves the links that point at it.", { rowId }, "delete", async ({ rowId: id }) => {
    await ctx.tables.deleteRow(id);
    return { deleted: id };
  });
  tool("get_row", "Read one row.", { rowId }, "read", ({ rowId: id }) => ctx.tables.getRow(id));
  tool(
    "query_rows",
    'Filter, sort, and page rows. A filter is {field, op, value} or {and: [...]} or {or: [...]}. Page with nextCursor. Example: {"field":"Age","op":"gt","value":30}.',
    { table: tableRef, filter: z.any().optional(), sort: z.object({ field: z.string(), direction: z.enum(["asc", "desc"]).optional() }).optional(), limit: z.number().int().optional(), cursor: z.string().optional() },
    "read",
    async ({ table, ...query }) => ctx.tables.queryRows((await ctx.table(table)).id, query),
  );
  return server;
}

export async function startMcp(ctx: Context): Promise<void> {
  await createMcpServer(ctx).connect(new StdioServerTransport());
}
