# agentic-tables

[![npm version](https://img.shields.io/npm/v/agentic-tables)](https://www.npmjs.com/package/agentic-tables)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-tables) · [Source](https://github.com/pooriaarab/agentic-tables) · [Support](https://github.com/pooriaarab/agentic-tables/issues)

Typed tables that agents read and write as rows.

> Status: release 0.4.0. See [CHANGELOG.md](CHANGELOG.md) for the changes.
>
> **Warning: the HTTP API has no authentication yet.** It reads the caller from
> `x-principal-*` headers and does not check who sent them. The Worker refuses every request with
> `503` until you set `AGENTIC_TABLES_UNSAFE_NO_AUTH=1`. Use that for local work
> only. Do not put the Worker on the public internet.

## Install

```sh
npm install agentic-tables agentic-identity
```

Node 22 or newer. The CLI runs with `npx agentic-tables --help`.

## Quick start

The library, the CLI, the MCP server, and the HTTP API work. The web UI is planned.

A base holds tables. A table has typed fields and rows. The library checks each
row against the schema before it writes.

```ts
import { createMemoryStore } from "agentic-identity";
import { createTables } from "agentic-tables";

const tables = createTables(createMemoryStore());
const base = await tables.createBase("Crm", { id: "u1", kind: "human" });
const people = await tables.createTable(base.id, "People", [
  { name: "Name", type: "text", required: true },
  { name: "Stage", type: "single_select", options: ["lead", "won"] },
]);
await tables.insertRow(people.id, { Name: "Ada", Stage: "lead" }, { id: "u1", kind: "human" });
```

## Features

- Field types: text, long text, number, checkbox, date, single select, multi select, link to another table, file ref.
- Every row keeps who created it and who last changed it, with the principal kind. An agent edit is labeled as an agent edit.
- Schema changes are safe. A rename keeps the values. A type change converts every value or changes nothing, and returns a report of the rows that fail. A dry run shows the report first. You can add and delete fields and change select options the same way.
- Queries: filters with `and` and `or`, per-type operators, one sort, `limit`, and a cursor. Saved views: a grid, and a board grouped by a single select field.
- Deleting a row removes it from the links that point at it.
- Storage sits behind the `Store` port from `agentic-identity`. Use its memory adapter in tests, its D1 adapter in a Worker, or the file store from `agentic-tables/file-store`. The file store passes the same contract suite (`runStoreContract`), so any adapter that passes it also works here.
- A change that reads before it writes runs in one `Store` transaction that reads first and writes after. Creating a base, and deleting a view, are single writes. This is the shared port rule, and Firestore follows it. A query guards only the docs it returned, so adding a row or a view bumps a `rev` counter on its table, and adding a table bumps one on its base. A change that read the table or base then runs again and sees the new doc. A busy table serializes its inserts for that reason.

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

The store runs only queries of this shape: `where` on a top-level id field (`tableId`, `baseId`, `ownerId` with `ownerKind`), and `orderBy` on `createdAt` or `updatedAt`. A Firestore adapter needs one composite index for each of those pairs.

- **In the store** (`plan: "store"`): a query with no filter and no field sort. The store filters by table, orders by `createdAt` or `updatedAt`, and pages.
- **In memory** (`plan: "memory"`): any filter, and any sort on a field. The library reads the rows of the table, then filters, sorts, and pages them.

These also run in memory, because the port has no query for them: the export and the erase of one principal read every base, table, and row they touch (the rows it wrote in other bases are found by a scan, matching author id and kind), and a field-level filter or sort reads the whole table.

A memory query reads at most `maxScan` rows (10,000 by default). A larger table fails the query with `SCAN_LIMIT`. It never returns a partial answer. Empty values sort last in both directions.

Operators by type: text `eq neq contains starts_with is_empty not_empty`; number and date `eq neq gt gte lt lte is_empty not_empty`; checkbox `eq neq`; single select `eq neq in is_empty not_empty`; multi select `has has_any has_all is_empty not_empty`; link `has is_empty not_empty`; file `is_empty not_empty`.

## UI

A small web app for your tables. It is built on [`agentic-design`](https://www.npmjs.com/package/agentic-design) and talks to the Worker through `agentic-tables/client`. The Worker serves it at `/`, next to the API under `/api/v1/tables`.

Run it on your machine:

```sh
npm ci
npm run dev:ui
```

Open the address that `wrangler dev` prints. The script builds the app, then starts the Worker with `AGENTIC_TABLES_UNSAFE_NO_AUTH=1` and `AGENTIC_TABLES_REGION=eu`. Use it for local work only. The Worker has no sign-in yet, so the app acts as the person `local-user` and anyone who can reach the Worker can read and write.

What it does:

- Lists your tables. The first visit makes a base called "My tables" to hold them.
- Shows a table as a grid with typed cells: text, long text, number, checkbox, date, single select, and multi select.
- Adds a table, a column, and a row. Edits a cell. Deletes a row, a column, or a table after a confirm.
- Filters on one column and sorts on one column or on the time of the last edit.
- Shows loading, empty, and error states. A failed call shows its reason.
- Marks a row whose last edit an agent made with the word "Agent" and an icon. Colour is never the only sign.
- Works with the keyboard. In the grid, the arrow keys, Home, and End move. Enter edits a cell (or toggles a checkbox). Enter saves and Escape cancels.
- Follows the system light or dark theme, or the pick in the top bar.

Run the browser tests, which start `wrangler dev` with a fresh local database:

```sh
npx playwright install chromium
npm run build && npm run test:e2e
```

They create a table, add a row, edit a cell, and reload to check that it stays. They also run an axe check for WCAG 2.2 AA on each view in both themes, and write screenshots to [`docs/screenshots`](docs/screenshots) (light and dark).

Limits of the UI: link and file cells show their value and cannot be edited. A column cannot be renamed or change type. Filters take one condition. It does not refresh when another caller writes: reload to see new rows.

## HTTP API

A Cloudflare Worker (Hono) serves `/api/v1/tables`. Data lives in D1, so it survives a restart and every Worker instance sees the same data.

Create the database in the EU, put its id in `wrangler.jsonc`, and set `AGENTIC_TABLES_REGION` for each deploy. There is no default, so a deploy cannot claim a region you did not state:

```sh
npx wrangler d1 create agentic-tables --location weur
npx wrangler deploy --var AGENTIC_TABLES_REGION:eu
```

`AGENTIC_TABLES_REGION` (`eu` or `us`) is a claim that you make. On each query, the adapter checks the region that D1 reports, and fails the query if it is outside the claim. The Worker answers `500` with `MISCONFIGURED` when the claim or the `DB` binding is missing, and when the claim is not exactly `eu` or `us`. If the table cannot be created, it answers `503`. It creates the table it needs on first use. The adapter checks queries only, so a wrong claim is not caught on a write: create the database with the location hint.

With the unsafe flag set, the Worker fills in the region of a query when D1 reports none, because `wrangler dev` reports none. A region that D1 reports is never changed. The flag is for local work only. A Worker without it serves nothing.

Local `wrangler dev` needs the same `--var` and keeps its own copy of the database and ignores the id. Two `wrangler dev` runs with the same `--persist-to` folder share it.

```sh
npx wrangler dev --var AGENTIC_TABLES_UNSAFE_NO_AUTH:1 --var AGENTIC_TABLES_REGION:eu
curl -X POST localhost:8787/api/v1/tables/bases -H 'x-principal-id: ada' -H 'x-principal-kind: human' -d '{"name":"Crm"}'
```

Every call needs `x-principal-id` and `x-principal-kind` (one of `human`, `agent_of_human`, `agent_of_agent`, `agent`, `user_token`). A missing or unknown kind returns `401`. The kind is kept on every row, so an agent write stays labeled. These headers stand in for sign-in until the identity package has it: nothing proves them.

- `x-principal-chain`: who the caller acts for, root first, as `human:ada` or `agent:a1,agent_of_agent:a2`. An agent of a person needs it. `resolveChain` from `agentic-identity` checks the parent kinds and the depth.
- `x-principal-scopes`: what the caller may do, as `table:read,base:read`. It defaults to everything. A caller never has more than its owner's role.

## SDK

`agentic-tables/client` is a typed client for the Worker API. It uses only `fetch`, so it runs in browsers, Workers, and Node 22. It has one method per route.

```ts
import { createClient, TablesClientError } from "agentic-tables/client";

const tables = createClient({
  baseUrl: "http://127.0.0.1:8787",
  principal: { id: "ada", kind: "human" },
});
const base = await tables.createBase("Crm");
const table = await tables.createTable(base.id, "People", [{ name: "Name", type: "text", required: true }]);
await tables.insertRow(table.id, { Name: "Ada" });
const page = await tables.queryRows(table.id, { sort: { field: "Name" }, limit: 50 });

try {
  await tables.getRow("row_0000000000000000");
} catch (error) {
  if (error instanceof TablesClientError) console.log(error.code, error.status); // NOT_FOUND 404
}
```

- `baseUrl` is the Worker origin. The client adds `/api/v1/tables`.
- `principal` sets the `x-principal-*` headers, which the Worker reads today. `token` is sent as `Authorization: Bearer`. The Worker does not read it yet. A call with no `principal` answers `401 UNAUTHENTICATED`.
- `fetch` replaces the global `fetch`.
- Every method takes `{ signal }` last. Abort it to cancel the call. An abort throws the error of `fetch` as it is.
- A failed call throws `TablesClientError` with `code`, `status`, and, where the API sends them, `issues` and `report`. A call that gets no answer has code `NETWORK` and status `0`. An answer that is not JSON has code `BAD_RESPONSE`.
- The client never retries. A repeat of a write could write twice, so retry in your own code where it is safe.

## Access

A base and a table are shared resources, and a table sits inside its base. Roles come from `agentic-identity`: viewer, commenter, editor, owner. A role on a base passes down to its tables. The person who creates a base owns it. An agent that acts for a person has the role of that person, cut down by its scopes. A role belongs to a kind and an id together: the person `sam` and the agent `sam` hold separate roles, and a share names the kind (`human` or `agent`).

| Role | Can |
| --- | --- |
| viewer | Read bases, tables, rows, and views. |
| editor | Also insert, change, and delete rows, and create and delete views. |
| owner | Also create a table, change a schema (fields, types, options, required), delete a table or a base, and share. A link field also needs the right to read the table it points at. |

Every call checks the role with `can()`, which writes an audit entry for each allow and each deny. A caller with no role gets `404`, the same answer as for an id that does not exist. A link value names a row, so it needs the right to read the linked table. A caller with a role that is too low, or a credential with too few scopes, gets `403` `FORBIDDEN`. `PUT /bases/:baseId/members/:kind/:subjectId` and `PUT /tables/:tableId/members/:kind/:subjectId` (`:kind` is `human` or `agent`) take `{"role": "viewer"}` and grant a role. `DELETE` on the same path takes it back. A comment role exists, but no route needs it yet.

`GET /me/export` and `DELETE /me/data` work only for a person or an agent with its own identity, and need the `base:admin` scope (and `table:admin` for a base that has tables, since their grants go too), because they act on the bases the caller owns. An agent that acts for a person gets `403`: it must not export or erase its owner's data. They touch the bases the caller created and still holds the owner role on. A base the caller gave away is not theirs to erase. They also cover every row the caller wrote in any other base, whatever the caller's role is now: a person may take back what they wrote. The export holds those rows as they are now, with the values that others wrote in them.

| Route | Use it for |
| --- | --- |
| `POST /bases`, `GET /bases` | Create and list bases. The list holds the bases the caller can read. |
| `POST /bases/:baseId/tables`, `GET /bases/:baseId/tables`, `GET /tables/:tableId` | Create, list, and read tables. |
| `POST /tables/:tableId/fields`, `PATCH` and `DELETE /tables/:tableId/fields/:field`, `POST /tables/:tableId/fields/:field/type` | Add, rename, delete, and retype a field. The retype body takes `dryRun` and `onFailure`. |
| `PUT /tables/:tableId/fields/:field/required` | Set `required`. A `409` lists the rows with no value. Add `dryRun` to only list them. |
| `DELETE /tables/:tableId`, `DELETE /bases/:baseId` | Delete with all rows and views. A table that another table links to returns `422`. |
| `GET /me/export`, `DELETE /me/data` | Export or hard delete the bases the caller owns. |
| `POST /tables/:tableId/rows` | Insert `{values}` or an all-or-nothing `{rows: [...]}`. |
| `GET /tables/:tableId/rows?filter=<json>&sort=Field:desc&limit=&cursor=` | Filter, sort, and page rows. |
| `GET`, `PATCH`, `DELETE /rows/:rowId` | Read, change, and delete a row. |
| `POST` and `GET /tables/:tableId/views`, `GET /views/:viewId/rows`, `DELETE /views/:viewId` | Saved views. |

A failure returns `{"error":{"code","message","issues"}}`: `422` for a validation failure, `409` for a migration that would lose data (the body holds the report), `404`, `403`, `400`, or `401`.

## Your data (GDPR)

A base has an owner: the principal that created it, by id and kind together. An id can belong to a person and to an agent, so export, erase, and the rows a principal wrote match both. Roles do not yet: `agentic-identity` keys a role on the id alone, so `agent:x` holds every role that `human:x` holds, until identity keys a role by kind too. A base with no owner kind is never exported and never erased as a whole. Two actions work by principal:

- **Export**: every base the principal owns, with its tables, views, and rows. It also lists `authoredRows`: the rows the principal wrote in bases it does not own. The output is one JSON object (`format: "agentic-tables-export"`, `version: 2`, `owner: {id, kind}`). Each row keeps the principal kind of its author.
- **Hard delete**: every base the principal owns goes in one transaction, and so does every row the principal wrote in other bases. Links to a deleted row are removed. Other rows in those bases stay. The store keeps no copy and no marker. With the file store, the file is rewritten without the data.

The result of a hard delete counts what it removed: `bases`, `tables`, `views`, `rows` (rows inside the owned bases), and `authoredRows` (rows in other bases).

| Surface | Export | Hard delete |
| --- | --- | --- |
| Library | `exportOwnerData({id, kind})` | `eraseOwnerData({id, kind})` |
| CLI | `export-data` | `erase-data --yes` |
| MCP | `export_my_data` | `erase_my_data` |
| HTTP | `GET /me/export` | `DELETE /me/data` |

The CLI, MCP, and HTTP actions act for the actor of the call only, and check the same roles as the HTTP API (see Access). In the unsafe mode the HTTP actor comes from unchecked headers, and the CLI and MCP actor comes from the environment, so anyone who can run the process can name any id. The CLI and MCP give each actor its own default base, so two actors on one file never share data by accident. Set `AGENTIC_TABLES_BASE` to a base id to work in a shared base: the owner shares it first.

Not covered yet: the rows keep the id of whoever last updated them (`updatedBy`) when another principal wrote them. File refs hold blob keys, and erase does not remove the blobs. A file store rewrite does not wipe old file blocks or backups. There is no retention setting. Rows that an agent writes for a person carry the id of the agent, so the person cannot export or erase them and the agent cannot either (it gets `403`). Erase keeps the audit entries that `can()` wrote and the sharing records: they hold ids, kinds, and roles, and no row content. The export holds all data in memory, so a very large export needs a streaming version later.

## Limits

- **Upgrading from 0.1.0:** a base made by 0.1.0 (the CLI, the MCP server, or the Worker) has no owner kind and no sharing record, so nobody has a role on it. Until its owner claims it, creating a base, export, and erase answer `409 LEGACY_BASE` with the base ids, and change nothing. Claim a base with `agentic-tables claim-base <id>`, the MCP tool `claim_base`, or `POST /bases/:baseId/claim`. The claim needs the scopes `base:admin`, `base:write`, and `table:write`. A credential without them gets `403` and changes nothing. The caller must be a person or an agent with its own identity, with the base owner id, and it states its own kind as the owner. The base and its tables then get sharing records. Rows a principal wrote in a base that is not its own are still exported and erased as `authoredRows`.
- A schema change runs in one store transaction. A very large table can exceed the transaction size of a backend.
- Deleting a table or a base runs in one store transaction. A very large one can exceed the transaction size of a backend. The CLI and MCP server cannot delete a base yet. The library and HTTP API can.
- Deleting a base or a table, and erasing your data, also removes its sharing records (the resource and its grants), with `deleteResource` from `agentic-identity` 0.4. A repeat of a delete finishes one that stopped half way, and an erase that stopped after its data went answers `409 ERASE_INCOMPLETE` with the base ids whose grants remain: `DELETE /bases/:id` on each one removes them. A base or a table with more than 100 owners is refused before anything is deleted: take some owners back first. Listing bases checks each base, so it grows with the number of bases and writes an audit entry per check. Roles pass to a base or a table, not to a single row. Whoever creates a table owns it. Revoking a person on a base also revokes them on each table in it (the revoker becomes a direct owner of each table first, so the person is never its last owner). It needs the `table:admin` scope too. You cannot remove yourself from a base that has tables: ask another owner. If a step fails, call again.
- A filter on a field value reads the whole table (up to `maxScan`). An index on field values comes later.
- On D1, a transaction is one batch of statements. A very large erase or import can exceed the limits of a D1 batch. D1 has no index for the queries this package makes, so each query scans its collection. Inserts into one table take turns, because each one bumps the table (see above).
- The file store (`agentic-tables/file-store`) keeps one JSON file. The CLI and the MCP server can share it: each write takes a lock file, reads the file again, and renames a new file into place. Each call reads the whole file, so use it for local work. It needs one machine: it does not work on a network disk. If a process dies, its lock is taken over when the process is gone or the lock is 30 seconds old. A lock with unreadable content is never taken: remove `<db>.lock` by hand.
- CSV export puts a `'` before any cell or header that starts with `=`, `+`, `-`, `@`, tab, or CR, so a spreadsheet shows it as text. Number and checkbox cells stay as they are. Import reads a guarded header back, but keeps a guarded cell as written, with the `'`.

## CLI

```sh
export AGENTIC_TABLES_DB=./crm.json            # default ./agentic-tables.json
export AGENTIC_TABLES_ACTOR=agent_of_human:claude   # who acts, as kind:id. Default human:cli (agent:mcp for the MCP server).
export AGENTIC_TABLES_CHAIN=human:ada          # who an agent of a person acts for, root first. Needs agent_of_human, not agent.
export AGENTIC_TABLES_SCOPES=table:read,base:read   # optional. Narrows what the actor may do. Default: everything.
export AGENTIC_TABLES_BASE=base_...            # optional. The base to work in. Default: one base per actor id.

npx agentic-tables new People --field "Name:text!" --field "Age:number" --field "Stage:single_select=lead|won"
npx agentic-tables insert People --json '{"Name":"Ada","Age":36,"Stage":"won"}'
npx agentic-tables query People --filter '{"field":"Age","op":"gt","value":30}' --sort Name:desc
npx agentic-tables schema People
npx agentic-tables required People Age true --dry-run   # lists rows with no Age
npx agentic-tables delete-table People --yes
npx agentic-tables share claude editor --kind agent                  # a role on your base: viewer, commenter, editor, owner
npx agentic-tables share claude viewer --kind agent --table People   # or on one table
npx agentic-tables unshare claude --kind agent
npx agentic-tables export People > people.csv
npx agentic-tables import Parts --file parts.csv --create
```

Commands: `new`, `list`, `schema`, `add-field`, `insert`, `update`, `query`, `export`, `import`, `required`, `delete-table`, `claim-base`, `share`, `unshare`, `export-data`, `erase-data`, `mcp`. Each prints JSON. A failure prints `{"error":{"code","message","issues"}}` on stderr and exits 1.

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
| `share`, `unshare` | Give or take back a role on your base or on one table. Only an owner can. |
| `claim_base` | Make a base from an earlier version usable. You must be its owner. |
| `export_my_data`, `erase_my_data` | Export or hard delete the bases the acting principal owns. |
| `insert_rows` | Insert up to 500 rows at once. One bad row writes none. |
| `update_row`, `delete_row`, `get_row` | Change, delete, or read one row. |
| `query_rows` | Filter, sort, and page rows. |

A failed call returns `isError` with a `code` and the `issues`. Rows written over MCP carry the actor from `AGENTIC_TABLES_ACTOR` (default `agent:mcp`). The server checks roles as the HTTP API does, and a refusal returns `isError` with the code `FORBIDDEN` or `NOT_FOUND`.

## Planned surfaces

- **Open formats**: ODS and XLSX export next to CSV. The plan is to write both with a small zip library under a permissive license, with every cell typed (string, number, boolean, date) and no formula cells, so no cell can run as a formula. A flat `.fods` file needs no zip.

## Develop

```sh
npm ci
npm run build && npm run typecheck && npm test
```

`npm run build` also builds the UI into `ui-dist`. The Worker config serves that folder, so build before you run `wrangler dev` or the tests.

## License

MIT.
