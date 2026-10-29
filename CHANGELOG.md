# Changelog

## 0.2.0

### Breaking changes

- **The Worker checks roles on every route.** Each route reads the caller from `x-principal-id` and `x-principal-kind`, and from `x-principal-chain` and `x-principal-scopes` when they are set. In 0.1.0 only creating a base, deleting a base or a table, row writes, export, and erase read these headers. Other routes, including reads of bases, tables, rows, and views, needed none. Now most requests without the headers answer `401 UNAUTHENTICATED`. `GET /bases` lists only the bases the caller can read. A caller with no role gets `404`. A role or a scope that is too low gets `403`.
- **The CLI and the MCP server check roles.** They read `AGENTIC_TABLES_CHAIN` and `AGENTIC_TABLES_SCOPES` as well as `AGENTIC_TABLES_ACTOR`. An agent of a person needs a chain: `AGENTIC_TABLES_ACTOR=agent_of_human:<id>` without `AGENTIC_TABLES_CHAIN` fails with `UNAUTHENTICATED`. Roles are checked as in the Worker.
- **The default base is matched on the owner's id and kind.** For an agent of a person, the default base is the person's base, not a base of the agent's own.
- **`AGENTIC_TABLES_BASE` needs a role.** In 0.1.0, naming an existing base was enough. Now the actor needs a role on that base. Without one it gets `NOT_FOUND`.
- **`createApp` takes the sharing store.** It is `createApp(tables, sharing)`, and it is exported from `agentic-tables/worker`. Code that mounts the app itself passes `createSharing(store)` as the second argument. Import `createSharing` from `agentic-identity` 0.3.
- **`Base` has `ownerKind`.** Code that builds or matches a `Base` must read this field.
- **Bases from 0.1.0 must be claimed.** A base made by 0.1.0 has no owner kind and no sharing record, so nobody has a role on it. Until its owner claims it, its tables and rows answer `NOT_FOUND`. Creating a base, export, and erase answer `409 LEGACY_BASE` in the Worker, with the base ids, and change nothing. The CLI and the MCP server print `LEGACY_BASE`. Without `AGENTIC_TABLES_BASE`, every CLI or MCP command that resolves the default base fails with `LEGACY_BASE` until the base is claimed.
- **Export and erase over the CLI, the MCP server, and the Worker touch only the caller's own bases.** They include only the bases the caller still owns and still holds the owner role on. A base the caller gave away is not exported or erased. The caller needs the `base:admin` scope. An agent that acts through a chain gets `FORBIDDEN`.
- **Roles are keyed on the principal id alone.** A person and an agent with the same id hold the same roles. 0.1.0 had no roles, so this is the model that the upgrade brings in. See the README.
- **The owner export is `version: 2`.** It names the owner as `owner: { id, kind }`. A row belongs to an owner when its author has the same id and kind.
- **`exportOwnerData` and `eraseOwnerData` on `createTables` take `{ id, kind }`.** They took an id string. They match bases on id and kind, and they check no role and no scope. Use them only in trusted code. A base from 0.1.0 has no owner kind, so these calls skip it and report no error. Claim each 0.1.0 base first. `legacyBaseIds(ownerId)` on the same object lists the bases that still need a claim. Callers that need the role and scope checks use the guarded paths above.

### Added

- `share` and `unshare` commands, and the `share` and `unshare` MCP tools. They grant or take back a role on a base or a table.
- `claim-base` and the `claim_base` MCP tool, and `POST /bases/:baseId/claim` in the Worker.
- Role routes in the Worker: `PUT` and `DELETE` on `/bases/:baseId/members/:subjectId` and `/tables/:tableId/members/:subjectId`.
- On the `createTables` object: `getView`, `legacyBaseIds`, and `setLegacyBaseOwnerKind`. The last two support the claim.

### Changed

- `agentic-identity` moves from ^0.2.0 to ^0.3.0.

### Migration from 0.1.0

1. Update the package: `npm install agentic-tables@0.2.0`.
2. Claim each base from 0.1.0. Run `agentic-tables export-data` as the owner. It fails with `LEGACY_BASE` and lists the base ids. Then run `agentic-tables claim-base <id>` for each id. The MCP tool is `claim_base`, and the Worker route is `POST /bases/:baseId/claim`. A base that 0.1.0 made while the actor was an agent of a person has that agent's id as its owner. Run these commands with `AGENTIC_TABLES_ACTOR=agent:<id>` and no chain to list and claim that base. The claim records the kind of the claimant, so the base is recorded as `agent`. The base then belongs to the agent alone. To give the person access, run `agentic-tables share <person-id> owner` as the agent, with `AGENTIC_TABLES_BASE` set to that base. Set `AGENTIC_TABLES_BASE` to that base in the agent's sessions too. Otherwise the agent works in a new default base.
3. Set the actor for each CLI or MCP session. Set `AGENTIC_TABLES_ACTOR` to `kind:id`. For an agent of a person, also set `AGENTIC_TABLES_CHAIN` to the person, root first, as `kind:id`. Set `AGENTIC_TABLES_SCOPES` to narrow what the agent may do.
4. For Worker clients, send the `x-principal-*` headers on every request. If you mount the app yourself, pass the sharing store to `createApp`.
5. If your code calls `exportOwnerData` or `eraseOwnerData` on `createTables`, pass `{ id, kind }`, not the id string. Claim the 0.1.0 bases first, because these calls skip them without an error. If your code reads the owner export, accept `version: 2`, and read `owner` as `{ id, kind }`.

On `createTables`, the insert and update methods still take an actor. Only the owner export and erase methods changed there.

## 0.1.0

First release.
