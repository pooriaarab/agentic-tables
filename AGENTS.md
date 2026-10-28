# agentic-tables agent guide

Typed tables that agents read and write as rows.

## Faces

- SDK: `import { createTables, createMemoryStore } from "agentic-tables"`.
- CLI: `npx agentic-tables --help`.
- MCP: `npx agentic-tables mcp`.

The HTTP API does not exist yet. Do not call a route that is not here.

## MCP tools

`list_tables`, `describe_table`, `create_table`, `add_field`, `insert_rows`,
`update_row`, `delete_row`, `get_row`, `query_rows`.

## The loop

1. Call `describe_table`. Read the field types, options, and required flags.
2. Insert or update rows with values that fit the types.
3. If a call fails, read `issues`. Fix the value. Do not guess a new field name.
4. Read rows back with `query_rows`.

## Rules

- Keep the domain logic behind the `Store` interface. Do not import Cloudflare or Firebase APIs in `src/`.
- Write the list of failure cases before you write the code for a check.
- Never log row content or an email address.
- Report a failed call as a failure. Do not retry with changed values to get past a check.
