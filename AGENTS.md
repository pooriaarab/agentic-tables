# agentic-tables agent guide

Typed tables that agents read and write as rows.

## Status

The package is in development. It exports `VERSION` only. The CLI, the MCP
server, and the HTTP API do not exist yet. Do not call a tool that is not here.

## Rules

- Keep the domain logic behind the `Store` interface. Do not import Cloudflare or Firebase APIs in `src/`.
- Write the list of failure cases before you write the code for a check.
- Never log row content or an email address.
