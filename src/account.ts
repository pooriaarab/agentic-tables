// The package's side of the account contract: a host calls `exportAccount` and `eraseAccount`
// and never reads the storage layout. The shape is provisional: it is the contract that the next
// `agentic-identity` release adds to `agentic-identity/account` as `AccountPackage`. The released 0.7.x has no such type.
//
// Both calls go through the guarded path (`exportMyData` and `eraseMyData`), so they keep its rules: a legacy base
// without an owner kind stops the call, a base the subject gave away is left alone, and the sharing records go
// with the data they belong to.
import { SUBJECT_KINDS, type Json, type PrincipalContext } from "agentic-identity";
import { TablesError, type Actor } from "./model.js";
import { createGuarded, type Sharing } from "./guarded.js";
import type { Tables } from "./tables.js";

export interface TablesAccountDeps {
  tables: Tables;
  sharing: Sharing;
  /** The subject's own context, with one step in its chain and the scopes `base:admin` and `table:admin`. */
  ctx: PrincipalContext;
}

export type TablesCollection = "bases" | "tables" | "views" | "rows" | "authored_rows";

export interface TablesAccount {
  id: "tables";
  /** Collections: `bases`, `tables`, `views`, `rows`, and `authored_rows` (rows the subject wrote in bases it does not own). It holds no format, version, or time: the host's manifest has the time. */
  exportAccount(subject: Actor, deps: TablesAccountDeps): Promise<Record<TablesCollection, Json[]>>;
  /** Hard deletes the bases the subject owns and the rows it wrote elsewhere. Counts by the same collection names. Run it with writes stopped: a row written after the export is erased and not exported. If it throws `ERASE_INCOMPLETE`, the data is gone but some grants remain, and the counts are lost: a repeat counts zero. */
  eraseAccount(subject: Actor, deps: TablesAccountDeps): Promise<Record<TablesCollection, number>>;
}

// Through JSON, so the records are what a file would hold: a key with no value is dropped, not left as `undefined`.
const plain = (value: unknown): Json[] => JSON.parse(JSON.stringify(value)) as Json[];

/** The guarded view of the subject. A context for anyone else is refused: it would export or erase their data. */
function guardedFor(subject: Actor, deps: TablesAccountDeps) {
  const { tables, sharing, ctx } = deps ?? ({} as Partial<TablesAccountDeps>);
  if (typeof tables?.exportOwnerData !== "function" || typeof tables.eraseOwnerData !== "function" || typeof sharing?.can !== "function") throw new TablesError("BAD_REQUEST", "tablesAccount needs deps.tables and deps.sharing");
  // Only a person or an agent holds a role in sharing, so any other kind would pass with nothing to export.
  const known = (SUBJECT_KINDS as readonly unknown[]).includes(subject?.kind);
  if (typeof subject?.id !== "string" || subject.id === "" || !known) throw new TablesError("BAD_REQUEST", "subject needs an id and a known kind");
  if (!Array.isArray(ctx?.chain)) throw new TablesError("BAD_REQUEST", "tablesAccount needs deps.ctx with a chain");
  const root = ctx.chain[0];
  if (ctx.chain.length !== 1 || root?.id !== subject.id || root.kind !== subject.kind || ctx.principalId !== subject.id || ctx.kind !== subject.kind) throw new TablesError("FORBIDDEN", "context does not match the subject");
  return createGuarded(tables, sharing)(ctx);
}

export const tablesAccount: TablesAccount = {
  id: "tables",
  async exportAccount(subject, deps) {
    const out = await guardedFor(subject, deps).exportMyData();
    return {
      bases: plain(out.bases.map((b) => b.base)),
      tables: plain(out.bases.flatMap((b) => b.tables)),
      views: plain(out.bases.flatMap((b) => b.views)),
      rows: plain(out.bases.flatMap((b) => b.rows)),
      authored_rows: plain(out.authoredRows),
    };
  },
  async eraseAccount(subject, deps) {
    const { bases, tables, views, rows, authoredRows } = await guardedFor(subject, deps).eraseMyData();
    return { bases, tables, views, rows, authored_rows: authoredRows };
  },
};
