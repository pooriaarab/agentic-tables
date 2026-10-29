# agentic-tables agent guide

Typed tables that agents read and write as rows.

## Faces

- SDK: `import { createTables } from "agentic-tables"`, with a `Store` from `agentic-identity` (`createMemoryStore`, `createD1Store`) or `createFileStore` from `agentic-tables/file-store`.
- CLI: `npx agentic-tables --help`.
- MCP: `npx agentic-tables mcp`.
- HTTP: a Worker from `agentic-tables/worker`, under `/api/v1/tables`. It answers
  `503` until `AGENTIC_TABLES_UNSAFE_NO_AUTH=1` is set. Use that for local work only.

Do not call a route that `src/worker.ts` does not define.

## MCP tools

`list_tables`, `describe_table`, `create_table`, `add_field`, `set_required`,
`delete_table`, `insert_rows`, `update_row`, `delete_row`, `get_row`,
`query_rows`, `export_my_data`, `erase_my_data`.

## The loop

1. Call `describe_table`. Read the field types, options, and required flags.
2. Insert or update rows with values that fit the types.
3. If a call fails, read `issues`. Fix the value. Do not guess a new field name.
4. Read rows back with `query_rows`.

## Rules

- Keep the domain logic behind the `Store` port from `agentic-identity`. Do not import Cloudflare or Firebase APIs in `src/`.
- In a transaction, read first and write after. A read after a write throws. Collect the writes, then apply them.
- Write the list of failure cases before you write the code for a check.
- Never log row content or an email address.
- Report a failed call as a failure. Do not retry with changed values to get past a check.
