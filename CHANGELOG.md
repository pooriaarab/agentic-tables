# Changelog

## 0.2.0

### Breaking changes

- **Owner export and erase take a principal.** `exportOwnerData` and `eraseOwnerData` take `{ id, kind }` instead of an id string. The export is `version: 2`, and it names the owner as `owner: { id, kind }`. A row belongs to an owner when its author has the same id and kind, so a person and an agent with one id no longer share data.
- **The CLI and MCP server take no actor.** The guard sets the actor from the environment: `AGENTIC_TABLES_ACTOR`, `AGENTIC_TABLES_CHAIN`, and `AGENTIC_TABLES_SCOPES`. The Tables API in the CLI and MCP no longer takes an actor argument.
- **Roles are checked on every face.** The CLI and the MCP server now check the same roles as the Worker. A caller with a role that is too low gets `FORBIDDEN`. A caller with no role gets `NOT_FOUND`.
- **Bases from 0.1.0 must be claimed.** A base made by 0.1.0 has no owner kind and no sharing record. Until its owner claims it, creating a base, export, and erase answer `409 LEGACY_BASE`, with the base ids, and change nothing.

### Added

- `share` and `unshare` commands, and the `share` and `unshare` MCP tools. They grant or take back a role on a base or a table.
- `claim-base` and the `claim_base` MCP tool, and `POST /bases/:baseId/claim` in the Worker.
- Role routes in the Worker: `PUT` and `DELETE` on `/bases/:baseId/members/:subjectId` and `/tables/:tableId/members/:subjectId`.
- `agentic-identity` ^0.3.0.

### Migration from 0.1.0

1. Update the package: `npm install agentic-tables@0.2.0`.
2. Claim each base from 0.1.0. Run `agentic-tables export-data` with the owner's `AGENTIC_TABLES_ACTOR`. It fails with `409 LEGACY_BASE` and lists the base ids. Then run `agentic-tables claim-base <id>` for each id. Use the MCP tool `claim_base` or `POST /bases/:baseId/claim` for the other faces.
3. Remove the actor from scripts that call the CLI or the MCP tools. Set `AGENTIC_TABLES_ACTOR` instead, as `kind:id`.
4. If your code calls `exportOwnerData` or `eraseOwnerData`, pass `{ id, kind }`, not the id string.
5. If your code reads the owner export, accept `version: 2`, and read `owner` as `{ id, kind }`.

The `createTables` insert and update methods still take an actor. The change is in the guarded API that the CLI, the MCP server, and the Worker use.

## 0.1.0

First release.
