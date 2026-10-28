# agentic-tables

[![npm version](https://img.shields.io/npm/v/agentic-tables)](https://www.npmjs.com/package/agentic-tables)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-tables) · [Source](https://github.com/pooriaarab/agentic-tables) · [Support](https://github.com/pooriaarab/agentic-tables/issues)

Typed tables that agents read and write as rows.

> Status: scaffold. This repository holds the starter code only. It is not on npm
> yet, and none of the features below work yet.

## Planned features

- Tables with typed fields: text, number, date, select, link, and file.
- Grid, board, and form views with filters and sorts.
- Real-time editing.
- Agent tools: query rows, insert rows, update rows, and change the schema.
- Import and export CSV.
- Share by invite or link, with roles.

## Surfaces

One package gives you each way in:

- **Library and SDK**: `import { ... } from "agentic-tables"`.
- **CLI**: `npx agentic-tables --help`.
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
