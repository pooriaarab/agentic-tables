import { readFileSync } from "node:fs";
import { ROLES, SUBJECT_KINDS, type Role, type SubjectKind } from "agentic-identity";
import { csvToValues, inferFields, parseCsv, toCsv } from "./csv.js";
import { openContext, type Context } from "./context.js";
import { errorBody } from "./errors.js";
import { FIELD_TYPES, TablesError, type FieldInput, type FieldType, type Row, type Values } from "./model.js";
import type { Json } from "agentic-identity";
import { VERSION } from "./version.js";

const HELP = `agentic-tables ${VERSION}
Typed tables that agents read and write as rows.

Usage: agentic-tables <command> [args] [flags]

Commands:
  new <name> --field <spec>...        Create a table.
  list                                List tables.
  schema <table>                      Print the fields of a table.
  add-field <table> --field <spec> [--default <json>]
  insert <table> --json <object|array>
  update <table> <rowId> --json <object>
  query <table> [--filter <json>] [--sort <Field[:desc]>] [--limit <n>] [--cursor <c>]
  export <table>                      Print the rows as CSV.
  import <table> --file <csv> [--create]
  required <table> <field> <true|false> [--dry-run]
  rename-field <table> <field> <newName>
  delete-field <table> <field> --yes  Delete a field and its values in every row.
  change-type <table> <field> --to <type> [--options <a|b>] [--link-table <t>] [--on-failure <abort|clear>] [--dry-run]
                                      Convert every value. "abort" (default) changes nothing if one fails. "clear" empties failed values.
  delete-table <table> --yes          Delete a table with its rows and views.
  bases                               List the bases you can read.
  new-base <name>                     Create a base. Use its id as AGENTIC_TABLES_BASE.
  delete-base <baseId> --yes          Delete a base with its tables, rows and views.
  claim-base <baseId>                 Make a base from an earlier version usable. You must be its owner.
  share <subject> <role> --kind <human|agent> [--table <t>]  Give a person or agent a role (viewer, commenter, editor, owner) on the base, or on one table.
  unshare <subject> --kind <human|agent> [--table <t>]     Take the role back.
  export-data                         Print every base the actor owns, as JSON.
  erase-data --yes                    Hard delete every base the actor owns.
  mcp                                 Start the MCP server on stdio.

A field spec is Name:type[!][=arg]. "!" means required. A select takes its
options after "=" split by "|". A link takes the table it links to.
Example: --field "Stage:single_select!=lead|won"
Types: ${FIELD_TYPES.join(", ")}.

Environment:
  AGENTIC_TABLES_DB      Database file. Default ./agentic-tables.json.
  AGENTIC_TABLES_ACTOR   Who acts, as kind:id. Default human:cli.
  AGENTIC_TABLES_CHAIN   Who an agent of a person acts for, root first, as kind:id,kind:id.
                         The actor of such an agent has the kind agent_of_human, for example agent_of_human:bot.
  AGENTIC_TABLES_SCOPES  What the actor may do, as table:read,base:read. Default: everything.
  AGENTIC_TABLES_BASE    The base to work in. Default: your own base.
`;

class UsageError extends Error {}

interface Parsed {
  command: string;
  args: string[];
  flags: Map<string, string[]>;
}

function parse(argv: string[]): Parsed {
  const [command = "help", ...rest] = argv;
  const args: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (!token.startsWith("--")) {
      args.push(token);
      continue;
    }
    const name = token.slice(2);
    const value = ["create", "yes", "dry-run"].includes(name) ? "true" : rest[++i];
    if (value === undefined) throw new UsageError(`flag --${name} needs a value`);
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  return { command, args, flags };
}

function json(text: string | undefined, what: string): Json {
  if (text === undefined) throw new UsageError(`${what} is required`);
  try {
    return JSON.parse(text) as Json;
  } catch {
    throw new UsageError(`${what} is not valid JSON`);
  }
}

async function fieldFromSpec(ctx: Context, spec: string): Promise<FieldInput> {
  const match = /^(.+?):([a-z_]+)(!?)(?:=(.*))?$/.exec(spec);
  if (!match || !FIELD_TYPES.includes(match[2] as FieldType)) throw new UsageError(`bad field spec "${spec}". Expected Name:type[!][=arg]`);
  const [, name, type, required, arg] = match as unknown as [string, string, FieldType, string, string | undefined];
  const field: FieldInput = { name, type, required: required === "!" };
  if (type === "single_select" || type === "multi_select") field.options = (arg ?? "").split("|").filter(Boolean);
  if (type === "link" && arg) field.linkTable = (await ctx.table(arg)).id;
  return field;
}

async function run(ctx: Context, { command, args, flags }: Parsed): Promise<unknown> {
  const flag = (name: string) => flags.get(name)?.[0];
  const need = (i: number, what: string) => args[i] ?? ((): never => { throw new UsageError(`${command} needs ${what}`); })();
  switch (command) {
    case "new": {
      const specs = await Promise.all((flags.get("field") ?? []).map((s) => fieldFromSpec(ctx, s)));
      return ctx.tables.createTable(await ctx.baseId(), need(0, "a table name"), specs);
    }
    case "list":
      return ctx.tables.listTables(await ctx.baseId());
    case "schema":
      return ctx.table(need(0, "a table"));
    case "add-field": {
      const table = await ctx.table(need(0, "a table"));
      const input = { ...(await fieldFromSpec(ctx, flag("field") ?? ((): never => { throw new UsageError("add-field needs --field"); })())) };
      return ctx.tables.addField(table.id, { ...input, ...(flag("default") === undefined ? {} : { default: json(flag("default"), "--default") }) });
    }
    case "insert": {
      const table = await ctx.table(need(0, "a table"));
      const body = json(flag("json"), "--json");
      if (Array.isArray(body)) return { rows: await ctx.tables.insertRows(table.id, body as Values[]) };
      return ctx.tables.insertRow(table.id, body as Values);
    }
    case "update": {
      const table = await ctx.table(need(0, "a table"));
      const row = await ctx.tables.getRow(need(1, "a row id"));
      if (row.tableId !== table.id) throw new TablesError("NOT_FOUND", `row "${row.id}" is not in table "${table.name}"`);
      return ctx.tables.updateRow(row.id, json(flag("json"), "--json") as Values);
    }
    case "query": {
      const table = await ctx.table(need(0, "a table"));
      const [field = "", direction] = (flag("sort") ?? "").split(":");
      return ctx.tables.queryRows(table.id, {
        filter: flag("filter") === undefined ? undefined : (json(flag("filter"), "--filter") as never),
        sort: field ? { field, direction: direction === "desc" ? "desc" : "asc" } : undefined,
        limit: flag("limit") === undefined ? undefined : Number(flag("limit")),
        cursor: flag("cursor"),
      });
    }
    case "required": {
      const table = await ctx.table(need(0, "a table"));
      const value = need(2, "true or false");
      if (value !== "true" && value !== "false") throw new UsageError("required needs true or false");
      return ctx.tables.setRequired(table.id, need(1, "a field"), value === "true", { dryRun: flag("dry-run") !== undefined });
    }
    case "delete-table": {
      const table = await ctx.table(need(0, "a table"));
      if (flag("yes") === undefined) throw new UsageError(`delete-table removes "${table.name}" with all its rows. Add --yes to confirm`);
      return ctx.tables.deleteTable(table.id);
    }
    case "rename-field": {
      const table = await ctx.table(need(0, "a table"));
      return ctx.tables.renameField(table.id, need(1, "a field"), need(2, "a new name"));
    }
    case "delete-field": {
      const table = await ctx.table(need(0, "a table"));
      const field = need(1, "a field");
      if (flag("yes") === undefined) throw new UsageError(`delete-field removes "${field}" and its values from every row of "${table.name}". Add --yes to confirm`);
      return ctx.tables.deleteField(table.id, field);
    }
    case "change-type": {
      const table = await ctx.table(need(0, "a table"));
      const to = flag("to");
      if (!FIELD_TYPES.includes(to as FieldType)) throw new UsageError(`change-type needs --to with one of ${FIELD_TYPES.join(", ")}`);
      const onFailure = flag("on-failure");
      if (onFailure !== undefined && onFailure !== "abort" && onFailure !== "clear") throw new UsageError("--on-failure must be abort or clear");
      return ctx.tables.changeFieldType(table.id, need(1, "a field"), {
        to: to as FieldType,
        ...(flag("options") === undefined ? {} : { options: flag("options")!.split("|").filter(Boolean) }),
        ...(flag("link-table") === undefined ? {} : { linkTable: (await ctx.table(flag("link-table")!)).id }),
        ...(onFailure === undefined ? {} : { onFailure }),
        dryRun: flag("dry-run") !== undefined,
      });
    }
    case "bases":
      return ctx.tables.listBases();
    case "new-base":
      return ctx.tables.createBase(need(0, "a base name"));
    case "delete-base": {
      const id = need(0, "a base id");
      if (flag("yes") === undefined) throw new UsageError(`delete-base removes base "${id}" with all its tables, rows and views. Add --yes to confirm`);
      return ctx.tables.deleteBase(id);
    }
    case "claim-base":
      return ctx.tables.claimBase(need(0, "a base id"));
    case "share":
    case "unshare": {
      const table = flag("table") === undefined ? undefined : await ctx.table(flag("table")!);
      const type = table ? "table" : "base";
      const resourceId = table ? table.id : await ctx.baseId();
      const subject = { kind: flag("kind") as SubjectKind, id: need(0, "a subject id") };
      if (!SUBJECT_KINDS.includes(subject.kind)) throw new UsageError(`${command} needs --kind ${SUBJECT_KINDS.join(" or ")}: a person and an agent can share one id`);
      if (command === "unshare") return (await ctx.tables.revokeGrant(type, resourceId, subject), { resourceId, subject });
      const role = need(1, "a role") as Role;
      if (!ROLES.includes(role)) throw new UsageError(`role must be one of ${ROLES.join(", ")}`);
      return (await ctx.tables.grant(type, resourceId, subject, role), { resourceId, subject, role });
    }
    case "export-data":
      return ctx.tables.exportMyData();
    case "erase-data":
      if (flag("yes") === undefined) throw new UsageError(`erase-data deletes every base owned by "${ctx.actor.id}". Add --yes to confirm`);
      return ctx.tables.eraseMyData();
    case "export": {
      const table = await ctx.table(need(0, "a table"));
      const rows: Row[] = [];
      let cursor: string | undefined;
      do {
        const page = await ctx.tables.queryRows(table.id, { limit: 1000, cursor });
        rows.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      return { raw: toCsv(table, rows) };
    }
    case "import": {
      const [header, ...records] = parseCsv(readFileSync(flag("file") ?? ((): never => { throw new UsageError("import needs --file"); })(), "utf8"));
      if (!header) throw new UsageError("the CSV file is empty");
      const name = need(0, "a table");
      let table = await ctx.table(name).catch((error: unknown) => {
        if (flag("create") === undefined) throw error;
        return undefined;
      });
      table ??= await ctx.tables.createTable(await ctx.baseId(), name, inferFields(header, records));
      const rows = await ctx.tables.insertRows(table.id, csvToValues(table, header, records));
      return { inserted: rows.length, table };
    }
    default:
      throw new UsageError(`unknown command "${command}"`);
  }
}

export async function main(argv: string[], env = process.env): Promise<number> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") return (process.stdout.write(HELP), 0);
  if (argv[0] === "--version" || argv[0] === "-V") return (console.log(VERSION), 0);
  try {
    const parsed = parse(argv);
    if (parsed.command === "mcp") {
      const { startMcp } = await import("./mcp.js");
      await startMcp(await openContext(env, "agent:mcp"));
      return 0;
    }
    const result = await run(await openContext(env, "human:cli"), parsed);
    if (typeof result === "object" && result !== null && "raw" in result) process.stdout.write((result as { raw: string }).raw);
    else console.log(JSON.stringify(result));
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(JSON.stringify({ error: { code: "USAGE", message: error.message } }));
      console.error('Run "agentic-tables --help" for usage.');
      return 2;
    }
    console.error(JSON.stringify(errorBody(error)));
    return 1;
  }
}
