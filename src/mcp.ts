import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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
  tool("delete_table", "Delete a table with all its rows and views. It fails while another table links to it.", { table: tableRef }, "delete", async ({ table }) => ctx.tables.deleteTable((await ctx.table(table)).id));
  tool("insert_rows", "Insert rows. Keys are field names. All rows are checked first. If one fails, none is written, and the error names the row and field.", { table: tableRef, rows: z.array(z.record(z.any())).min(1).max(500) }, "write", async ({ table, rows }) => ({
    rows: await ctx.tables.insertRows((await ctx.table(table)).id, rows as Values[], ctx.actor),
  }));
  tool("update_row", "Change fields of one row. Send only the fields to change. Send null to empty a field.", { rowId, values: z.record(z.any()) }, "write", ({ rowId: id, values }) => ctx.tables.updateRow(id, values as Values, ctx.actor));
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
