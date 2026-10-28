# agentic-tables

[![npm version](https://img.shields.io/npm/v/agentic-tables)](https://www.npmjs.com/package/agentic-tables)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-tables) · [Source](https://github.com/pooriaarab/agentic-tables) · [Support](https://github.com/pooriaarab/agentic-tables/issues)

Typed tables that agents read and write as rows.

> Status: in development. Not on npm yet.
>
> **Warning: the HTTP API has no authentication yet.** It reads the caller from
> two headers and does not check them. The Worker refuses every request with
> `503` until you set `AGENTIC_TABLES_UNSAFE_NO_AUTH=1`. Use that for local work
> only. Do not put the Worker on the public internet.

## What works

The library, the CLI, the MCP server, and the HTTP API work. The web UI is planned.

A base holds tables. A table has typed fields and rows. The library checks each
row against the schema before it writes.

```ts
import { createTables, createMemoryStore } from "agentic-tables";

const tables = createTables(createMemoryStore());
const base = await tables.createBase("Crm");
const people = await tables.createTable(base.id, "People", [
  { name: "Name", type: "text", required: true },
  { name: "Stage", type: "single_select", options: ["lead", "won"] },
]);
await tables.insertRow(people.id, { Name: "Ada", Stage: "lead" }, { id: "u1", kind: "human" });
```

- Field types: text, long text, number, checkbox, date, single select, multi select, link to another table, file ref.
- Every row keeps who created it and who last changed it, with the principal kind. An agent edit is labeled as an agent edit.
- Schema changes are safe. A rename keeps the values. A type change converts every value or changes nothing, and returns a report of the rows that fail. A dry run shows the report first. You can add and delete fields and change select options the same way.
- Queries: filters with `and` and `or`, per-type operators, one sort, `limit`, and a cursor. Saved views: a grid, and a board grouped by a single select field.
- Deleting a row removes it from the links that point at it.
- Storage sits behind the `Store` interface from `agentic-identity`. An in-memory store and a local file store ship now.

## Queries

```ts
const page = await tables.queryRows(people.id, {
  filter: { and: [{ field: "Stage", op: "eq", value: "lead" }, { field: "Age", op: "gte", value: 18 }] },
  sort: { field: "Name" },
  limit: 25,
});
// page.items, page.nextCursor, page.plan
```

The `Store` port has equality filters, one `orderBy`, a limit, and a cursor. Field values are not top-level fields, so the port cannot filter on them.

- **In the store** (`plan: "store"`): a query with no filter and no field sort. The store filters by table, orders by `createdAt` or `updatedAt`, and pages.
- **In memory** (`plan: "memory"`): any filter, and any sort on a field. The library reads the rows of the table, then filters, sorts, and pages them.

A memory query reads at most `maxScan` rows (10,000 by default). A larger table fails the query with `SCAN_LIMIT`. It never returns a partial answer. Empty values sort last in both directions.

Operators by type: text `eq neq contains starts_with is_empty not_empty`; number and date `eq neq gt gte lt lte is_empty not_empty`; checkbox `eq neq`; single select `eq neq in is_empty not_empty`; multi select `has has_any has_all is_empty not_empty`; link `has is_empty not_empty`; file `is_empty not_empty`.

## HTTP API

A Cloudflare Worker (Hono) serves `/api/v1/tables`. The store is in memory, so state lasts as long as one Worker instance.

```sh
npx wrangler dev --var AGENTIC_TABLES_UNSAFE_NO_AUTH:1
curl -X POST localhost:8787/api/v1/tables/bases -H 'x-principal-id: ada' -H 'x-principal-kind: human' -d '{"name":"Crm"}'
```

Writes need `x-principal-id` and `x-principal-kind` (one of `human`, `agent_of_human`, `agent_of_agent`, `agent`, `user_token`). A missing or unknown kind returns `401`. The kind is kept on every row, so an agent write stays labeled.

| Route | Use it for |
| --- | --- |
| `POST /bases`, `GET /bases` | Create and list bases. |
| `POST /bases/:baseId/tables`, `GET /bases/:baseId/tables`, `GET /tables/:tableId` | Create, list, and read tables. |
| `POST /tables/:tableId/fields`, `PATCH` and `DELETE /tables/:tableId/fields/:field`, `POST /tables/:tableId/fields/:field/type` | Add, rename, delete, and retype a field. The retype body takes `dryRun` and `onFailure`. |
| `PUT /tables/:tableId/fields/:field/required` | Set `required`. A `409` lists the rows with no value. Add `dryRun` to only list them. |
| `DELETE /tables/:tableId`, `DELETE /bases/:baseId` | Delete with all rows and views. A table that another table links to returns `422`. |
| `POST /tables/:tableId/rows` | Insert `{values}` or an all-or-nothing `{rows: [...]}`. |
| `GET /tables/:tableId/rows?filter=<json>&sort=Field:desc&limit=&cursor=` | Filter, sort, and page rows. |
| `GET`, `PATCH`, `DELETE /rows/:rowId` | Read, change, and delete a row. |
| `POST` and `GET /tables/:tableId/views`, `GET /views/:viewId/rows`, `DELETE /views/:viewId` | Saved views. |

A failure returns `{"error":{"code","message","issues"}}`: `422` for a validation failure, `409` for a migration that would lose data (the body holds the report), `404`, `400`, or `401`.

## Limits

- A schema change runs in one store transaction. A very large table can exceed the transaction size of a backend.
- Deleting a table or a base runs in one store transaction. A very large one can exceed the transaction size of a backend. The CLI and MCP server cannot delete a base yet. The library and HTTP API can.
- A filter on a field value reads the whole table (up to `maxScan`). An index on field values comes later.
- The file store (`agentic-tables/file-store`) keeps one JSON file. The CLI and the MCP server can share it: each write takes a lock file, reads the file again, and renames a new file into place. Each call reads the whole file, so use it for local work. It needs one machine: it does not work on a network disk. If a process dies, its lock is taken over when the process is gone or the lock is 30 seconds old. A lock with unreadable content is never taken: remove `<db>.lock` by hand.
- CSV export puts a `'` before any cell or header that starts with `=`, `+`, `-`, `@`, tab, or CR, so a spreadsheet shows it as text. Number and checkbox cells stay as they are. Import reads a guarded header back, but keeps a guarded cell as written, with the `'`.

## CLI

```sh
export AGENTIC_TABLES_DB=./crm.json            # default ./agentic-tables.json
export AGENTIC_TABLES_ACTOR=agent:claude       # who writes, as kind:id. Default human:cli.

npx agentic-tables new People --field "Name:text!" --field "Age:number" --field "Stage:single_select=lead|won"
npx agentic-tables insert People --json '{"Name":"Ada","Age":36,"Stage":"won"}'
npx agentic-tables query People --filter '{"field":"Age","op":"gt","value":30}' --sort Name:desc
npx agentic-tables schema People
npx agentic-tables required People Age true --dry-run   # lists rows with no Age
npx agentic-tables delete-table People --yes
npx agentic-tables export People > people.csv
npx agentic-tables import Parts --file parts.csv --create
```

Commands: `new`, `list`, `schema`, `add-field`, `insert`, `update`, `query`, `export`, `import`, `required`, `delete-table`, `mcp`. Each prints JSON. A failure prints `{"error":{"code","message","issues"}}` on stderr and exits 1.

CSV import checks every cell first. If one cell fails, no row is written, and the error names the line and field. `--create` makes the table and guesses a type for each column: number, checkbox, date, single select, long text, or text. A column is a number only if every value is a plain decimal. `00123`, `0x1F`, and `1e3` stay text.

## MCP server

Run `npx agentic-tables mcp`. It uses the same database file as the CLI, and a CLI write while it runs is kept.

| Tool | Use it for |
| --- | --- |
| `list_tables` | List the tables with their fields. |
| `describe_table` | Read one schema, with the filter operators each field supports. Call it before you write. |
| `create_table`, `add_field` | Create a table. Add a field. |
| `set_required` | Make a field required or optional. It lists the rows that block it. |
| `delete_table` | Delete a table with its rows and views. |
| `insert_rows` | Insert up to 500 rows at once. One bad row writes none. |
| `update_row`, `delete_row`, `get_row` | Change, delete, or read one row. |
| `query_rows` | Filter, sort, and page rows. |

A failed call returns `isError` with a `code` and the `issues`. Rows written over MCP carry the actor from `AGENTIC_TABLES_ACTOR` (default `agent:mcp`).

## Planned surfaces

- **Durable storage for the Worker**: a D1 adapter.
- **Web UI**: a small app served by the same Worker.

## Develop

```sh
npm ci
npm run build && npm run typecheck && npm test
```

## License

MIT.
