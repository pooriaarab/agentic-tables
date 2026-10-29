// The package's side of the account contract: a host calls `exportAccount` and `eraseAccount`
// and never reads the storage layout. The shape is provisional: it is the contract that the next
// `agentic-identity` release adds to `agentic-identity/account` as `AccountPackage`. The released 0.7.x has no such type.
import type { Json } from "agentic-identity";
import type { Actor } from "./model.js";
import type { Tables } from "./tables.js";

export interface TablesAccountDeps {
  tables: Tables;
}

export interface TablesAccount {
  id: "tables";
  /** Collections: `bases`, `tables`, `views`, `rows`, and `authored_rows` (rows the subject wrote in bases it does not own). */
  exportAccount(subject: Actor, deps: TablesAccountDeps): Promise<Record<string, Json[]>>;
  /** Hard deletes the subject's bases and the rows it wrote elsewhere. Counts by the same collection names. */
  eraseAccount(subject: Actor, deps: TablesAccountDeps): Promise<Record<string, number>>;
}

// The export has collections only: no format, version, or time. The host's manifest holds the time.
// Through JSON, so the records are what a file would hold: a key with no value is dropped, not left as `undefined`.
const plain = (value: unknown): Json[] => JSON.parse(JSON.stringify(value)) as Json[];

// A host that passes no tables fails with a clear error, not a TypeError.
const need = (deps: TablesAccountDeps): Tables => {
  if (typeof deps?.tables?.exportOwnerData !== "function") throw new Error("tablesAccount needs deps.tables");
  return deps.tables;
};

export const tablesAccount: TablesAccount = {
  id: "tables",
  async exportAccount(subject, deps) {
    const out = await need(deps).exportOwnerData(subject);
    return {
      bases: plain(out.bases.map((b) => b.base)),
      tables: plain(out.bases.flatMap((b) => b.tables)),
      views: plain(out.bases.flatMap((b) => b.views)),
      rows: plain(out.bases.flatMap((b) => b.rows)),
      authored_rows: plain(out.authoredRows),
    };
  },
  async eraseAccount(subject, deps) {
    const { bases, tables: tableCount, views, rows, authoredRows } = await need(deps).eraseOwnerData(subject);
    return { bases, tables: tableCount, views, rows, authored_rows: authoredRows };
  },
};
