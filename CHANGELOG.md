# Changelog

## Unreleased

### Removed

- `agentic-tables/ui` no longer exports `clientFor` or `TablesApp`. Neither was documented, and `mount` uses both inside the module. Use `mount` to render the app.

## 0.7.1

**Read the changed id rule below before you upgrade.** A principal id that worked in 0.7.0 can now fail.

### Changed

- Principal parsing uses `parsePrincipal` from agentic-identity 0.6. An id must now use only A-Z a-z 0-9 . _ -, must not start with a dot, and has at most 128 characters. An id such as an email address, or one with a colon, now fails. A bad id in a header or in `AGENTIC_TABLES_CHAIN` fails with `UNAUTHENTICATED`. A bad `AGENTIC_TABLES_ACTOR` fails with `USAGE` (CLI and MCP).
- The `agentic-identity` dependency is now `^0.6.0`. If your project also depends on `agentic-identity`, upgrade it to 0.6 too, so that one copy of it is installed.
- The local copy of the principal kind and id checks is gone. `parsePrincipal` is the one check.

## 0.7.0

No breaking changes.

### Added

- `agentic-tables/ui` exports `mount`, which renders the tables app into an element against a base URL and a token callback. It returns `update` and `unmount`. `agentic-tables/ui.css` holds its styles. `react` and `react-dom` are optional peer dependencies, and `agentic-design` is now a dependency, because the UI imports it at run time.

### Fixed

- `agentic-tables-mcp --help` and `-h` print the usage and exit `0`. Before, the bin started a stdio server, so the command waited for input. `--version` and `-V` print the version.

### Changed

- The UI browser spec (`e2e/ui.spec.ts`) runs in CI on every pull request and on `main`. Before, CI did not run the browser spec, so a UI regression could merge.

## 0.6.0

No breaking changes.

### Added

- **Run on Firebase.** `agentic-tables/node` serves the HTTP API from Node over any `Store`. The HTTP end-to-end suite now runs on the Firestore emulator in CI, as well as on the Worker over D1.

### Changed

- The route code moved from `src/worker.ts` to `src/app.ts`, so the Node server does not load the D1 adapter. `createApp` is still exported from `agentic-tables/worker`.
- The `agentic-identity` dependency is now `^0.5.0`. If your project also depends on `agentic-identity`, upgrade it to 0.5 too, so that one copy of it is installed.
- The Worker no longer needs the `nodejs_compat` compatibility flag. The README says not to add it.

## 0.5.0

No breaking changes.

### Added

- **A minimal web UI.** The Worker of this repository serves an app at `/`, next to the API under `/api/v1/tables`. The app is built on `agentic-design` and uses `agentic-tables/client`. It lists your tables and shows each one as a keyboard grid with typed cells. You can add and delete rows, columns, and tables, and edit cells. It has one filter, one sort, and loading, empty, and error states. A row that an agent last edited carries an "Agent" marker. Like the API, it needs `AGENTIC_TABLES_UNSAFE_NO_AUTH=1` for local work, because the Worker has no sign-in yet.
- **The UI ships in the npm package.** The package includes the built app in `ui-dist`. To serve it from your own Worker, point the `assets` setting at `node_modules/agentic-tables/ui-dist`. The README shows the setting. The folder also has `THIRD_PARTY_NOTICES.md`, with the licenses of the code and fonts that the app bundles.

### Changed

- **The repository's Worker needs the UI build.** Its `wrangler.jsonc` serves `ui-dist`, which `npm run build` makes. Run `npm run build` before `wrangler dev` or `wrangler deploy` in this repository. The build also runs `vite build` now, so it needs the dev dependencies `vite`, `@vitejs/plugin-react`, `react`, `react-dom` and `agentic-design`. The API and the package exports did not change.

## 0.4.0

No breaking changes.

### Added

- **A remote client for the Worker API.** `createClient` from `agentic-tables/client` has one typed method for each route under `/api/v1/tables`. Inserting rows has two: one row, or a batch. It uses only `fetch`, so it runs in browsers, Workers, and Node 22. Options: `baseUrl`, `token`, `principal`, `fetch`.
- **Typed errors.** A failed call throws `TablesClientError` with the API `code` and the HTTP `status`, and with `issues` or `report` when the API sends them. Status `0` means no call was answered: code `NETWORK` for a call that got no answer, or `BAD_REQUEST` for a call the client refused before it sent it. An answer that is not JSON has code `BAD_RESPONSE`. A call that you cancel throws the abort error from `fetch`.
- **Cancel and no retry.** Every method takes `{ signal }` last. The client sends each call once and never retries.
- **`principal` sets the caller.** The Worker reads `x-principal-*` headers, so the client sends them from `principal`. `token` is sent as `Authorization: Bearer`. The Worker does not read it yet.
- **New subpath export `agentic-tables/client`.** This is why the release is a minor one.

## 0.3.0

### Breaking changes

- **Needs `agentic-identity` ^0.4.0.** Grants are keyed on a principal kind and an id. A person and an agent with the same id no longer share a role.
- **Sharing names the kind.** `grant` and `revokeGrant` on the guarded API take a subject `{ kind, id }`, where `kind` is `human` or `agent`. The routes are now `PUT` and `DELETE` on `/bases/:baseId/members/:kind/:subjectId` and `/tables/:tableId/members/:kind/:subjectId`. The old path with no kind answers `404`. The CLI `share` and `unshare` need `--kind human|agent`. The MCP tools `share` and `unshare` need `kind`. A missing or unknown kind is refused.
- **Deleting a base that has tables, and erasing data, need the `table:admin` scope too.** Their grants are removed, so a credential with `base:admin` alone gets `403`. A base or a table with more than 100 owners is refused with `400` before anything is deleted.
- **Grants from 0.2.0 stay under the old key.** `agentic-identity` 0.4 does not honor them. Run `migrateGrants(store)` from `agentic-identity` once before you serve, and check that `unresolved` is empty: a grant it cannot move still counts as an owner when a resource is deleted.

### Changed

- Deleting a table or a base, and erasing your data, removes the sharing records (resource and grants) with `deleteResource`. Before, they stayed in the store. A repeat of a table or base delete finishes one that stopped after the data went. If an erase stops after the data went, it answers `409 ERASE_INCOMPLETE` and names the bases whose grants remain. `DELETE /bases/:id` finishes each one.
- A table resource that 0.2.0 left behind after `deleteTable` still has its base as parent, and `deleteResource` refuses a base that has a child. A table made while its base is being deleted has the same effect. Delete such a table record with `DELETE /tables/:id` before you delete its base, if you know its id.
- `setLegacyBaseOwnerKind` on `createTables` succeeds when the base already has the same owner kind. Before, it threw `NotFoundError` for that case. It still throws `NotFoundError` when the base is missing, is not the owner's, or has a different kind. A duplicate claim that races the first one now succeeds. Code that calls this method directly must not expect the throw.

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
