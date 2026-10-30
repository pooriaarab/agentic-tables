---
name: agentic-tables
description: Typed tables that agents read and write as rows. Use to keep structured data with a schema, validate rows, and query them.
---

# agentic-tables

## Use the MCP server

Start it with `npx agentic-tables mcp`. Call `describe_table` first. Then use
`insert_rows`, `update_row`, `query_rows`, `get_row`, and `delete_row`.
`insert_rows` writes all rows or none. Use `rename_table` to change a table name.
It requires owner access and keeps the table id and data. The CLI command is
`rename-table <table> <newName>`.

## Use the CLI

```sh
agentic-tables new People --field "Name:text!" --field "Age:number"
agentic-tables insert People --json '{"Name":"Ada","Age":36}'
agentic-tables query People --filter '{"field":"Age","op":"gt","value":30}'
```

## Rules

- Read the schema before you write.
- Treat a failed call as a failure. Read `issues` and fix the value.
