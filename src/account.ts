// The package's side of the account contract: a host calls `exportAccount` and `eraseAccount`
// and never reads the storage layout. The shape matches `AccountPackage` in `agentic-identity/account`.
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

export const tablesAccount: TablesAccount = {
  id: "tables",
  async exportAccount(subject, { tables }) {
    const out = await tables.exportOwnerData(subject);
    return {
      bases: out.bases.map((b) => b.base as unknown as Json),
      tables: out.bases.flatMap((b) => b.tables as unknown as Json[]),
      views: out.bases.flatMap((b) => b.views as unknown as Json[]),
      rows: out.bases.flatMap((b) => b.rows as unknown as Json[]),
      authored_rows: out.authoredRows as unknown as Json[],
    };
  },
  async eraseAccount(subject, { tables }) {
    const { bases, tables: tableCount, views, rows, authoredRows } = await tables.eraseOwnerData(subject);
    return { bases, tables: tableCount, views, rows, authored_rows: authoredRows };
  },
};
