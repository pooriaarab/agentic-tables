# Changelog

## 0.2.0

### Breaking changes

- **The Worker checks roles on every route.** Each route reads the caller from `x-principal-id` and `x-principal-kind`, and from `x-principal-chain` and `x-principal-scopes` when they are set. In 0.1.0 only writes read these headers, so reads needed none. Now a request without them answers `401 UNAUTHENTICATED`. `GET /bases` lists only the bases the caller can read. A caller with no role gets `404`. A role or a scope that is too low gets `403`.
- **The CLI and the MCP server check roles.** They read `AGENTIC_TABLES_CHAIN` and `AGENTIC_TABLES_SCOPES` as well as `AGENTIC_TABLES_ACTOR`. An agent of a person needs a chain: `AGENTIC_TABLES_ACTOR=agent_of_human:<id>` without `AGENTIC_TABLES_CHAIN` fails with `UNAUTHENTICATED`. The default base is matched on the owner's id and kind, not on the id alone. Roles are checked as in the Worker.
- **`createApp` takes the sharing store.** It is `createApp(tables, sharing)`. Code that mounts the app itself passes `createSharing(store)` as the second argument.
- **`Base` has `ownerKind`.** Code that builds or matches a `Base` must read this field. A base made by 0.1.0 has no owner kind, so see the next item.
- **Bases from 0.1.0 must be claimed.** A base made by 0.1.0 has no owner kind and no sharing record, so nobody has a role on it. Until its owner claims it, its tables and rows answer `NOT_FOUND`. Creating a base, export, and erase answer `409 LEGACY_BASE` in the Worker, with the base ids, and change nothing. The CLI and the MCP server print `LEGACY_BASE`. Without `AGENTIC_TABLES_BASE`, every CLI or MCP command that resolves the default base fails with `LEGACY_BASE` until the base is claimed.
- **Owner export and erase take a principal.** `exportOwnerData` and `eraseOwnerData` take `{ id, kind }` instead of an id string. Only the bases the caller owns, and still holds the owner role on, are included. A base the caller gave away is not exported or erased. The caller must hold the `base:admin` scope. An agent that acts through a chain gets `FORBIDDEN`.
- **The export format is `version: 2`.** It names the owner as `owner: { id, kind }`. A row belongs to an owner when its author has the same id and kind, so a person and an agent with one id no longer share data.

### Added

- `share` and `unshare` commands, and the `share` and `unshare` MCP tools. They grant or take back a role on a base or a table.
- `claim-base` and the `claim_base` MCP tool, and `POST /bases/:baseId/claim` in the Worker.
- Role routes in the Worker: `PUT` and `DELETE` on `/bases/:baseId/members/:subjectId` and `/tables/:tableId/members/:subjectId`.

### Changed

- `agentic-identity` moves from ^0.2.0 to ^0.3.0.

### Migration from 0.1.0

1. Update the package: `npm install agentic-tables@0.2.0`.
2. Claim each base from 0.1.0. Run `agentic-tables export-data` as the owner. It fails with `LEGACY_BASE` and lists the base ids. Then run `agentic-tables claim-base <id>` for each id. The MCP tool is `claim_base`, and the Worker route is `POST /bases/:baseId/claim`.
3. Set the actor for each CLI or MCP session. Set `AGENTIC_TABLES_ACTOR` to `kind:id`. For an agent of a person, also set `AGENTIC_TABLES_CHAIN` to the person, root first, as `kind:id`. Set `AGENTIC_TABLES_SCOPES` to narrow what the agent may do.
4. For Worker clients, send the `x-principal-*` headers on read routes too. If you mount the app yourself, pass the sharing store to `createApp`.
5. If your code calls `exportOwnerData` or `eraseOwnerData`, pass `{ id, kind }`, not the id string. If your code reads the owner export, accept `version: 2`, and read `owner` as `{ id, kind }`.

The `createTables` insert and update methods still take an actor. The changes above are in the guarded API that the CLI, the MCP server, and the Worker use.

## 0.1.0

First release.
