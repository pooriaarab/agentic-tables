---
name: agentic-tables
description: Typed tables that agents read and write as rows. Keywords: database,tables,airtable,rows,schema,agents,mcp,cli,structured-data.
---

# agentic-tables

Typed tables that agents read and write as rows.

## Use the SDK

```js
import { summarizeText, dispatchText } from "agentic-tables";

summarizeText("some text");
await dispatchText("some text", { dryRun: true });
```

## Use the CLI

```sh
agentic-tables summary --text "some text"
agentic-tables dispatch --text "some text" --dry-run
```

## Use the MCP server

Start the server with `agentic-tables mcp`. Call `summarize_text`
for stats, `dispatch_text` for routes, `get_cost_report` for costs.

## Rules

- Preview each route with dry run first.
- Report guard denials and adapter errors as failures.
- Read the cost report at the end.
