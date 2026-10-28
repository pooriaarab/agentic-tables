# agentic-tables

[![npm version](https://img.shields.io/npm/v/agentic-tables)](https://www.npmjs.com/package/agentic-tables)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-tables) · [Source](https://github.com/pooriaarab/agentic-tables) · [Support](https://github.com/pooriaarab/agentic-tables/issues)

Typed tables that agents read and write as rows.

> Status: in development. The package exports `VERSION` only. It is not on npm
> yet, and none of the features below work yet.

## What works

The library works. The CLI, MCP server, HTTP API, and web UI are planned.

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
- Storage sits behind the `Store` interface from `agentic-identity`. An in-memory store ships now.

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

## Limits

- A schema change runs in one store transaction. A very large table can exceed the transaction size of a backend.
- You cannot change `required` on an existing field yet.
- You cannot delete a table or a base yet.
- A filter on a field value reads the whole table (up to `maxScan`). An index on field values comes later.
- Data lives in memory and is lost on exit.

## Planned surfaces

One package gives you each way in:

- **Library and SDK**: `import { ... } from "agentic-tables"`.
- **CLI**: `npx agentic-tables`.
- **MCP server**: `npx agentic-tables mcp`, for Claude Code and other MCP clients.
- **HTTP API**: a Cloudflare Worker you deploy to your own account.
- **Web UI**: a small app served by the same Worker.

## Develop

```sh
npm ci
npm run build && npm run typecheck && npm test
```

## License

MIT.
