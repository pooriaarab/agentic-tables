import { createSharing, hasScope, type Action, type PrincipalContext, type Role } from "agentic-identity";
import { NotFoundError, TablesError, type Actor, type FieldInput, type Values } from "./model.js";
import type { AddFieldInput, ChangeTypeOptions, ListRowsOptions, RowQuery, Tables, ViewInput } from "./tables.js";

export type Sharing = ReturnType<typeof createSharing>;

/**
 * Tables with access checks. A base and a table are shared resources (a table sits inside its base), so a
 * role on a base passes down to its tables. `forCaller` gives the API of `Tables` for one caller. Each call
 * asks `can()` first. `can()` writes an audit entry for every allow and every deny.
 *
 * Needs: read to look, write for rows, views, and new tables, admin (owner) to change a schema or delete.
 * A caller with no role at all gets "not found", so a stranger cannot learn that an id exists.
 */
export function createGuarded(tables: Tables, sharing: Sharing) {
  async function need(ctx: PrincipalContext, action: Action, resourceId: string, type: "base" | "table"): Promise<void> {
    const { allowed, role } = await sharing.can(ctx, action, resourceId);
    if (allowed) return;
    // A credential with too few scopes is refused by name, so an agent can tell why. Else a role with too little rights is refused. No role: not found.
    if (!hasScope(ctx.scopes, `${type}:${action}`)) throw new TablesError("FORBIDDEN", `this credential does not allow ${action} on a ${type}`);
    throw role === undefined ? new NotFoundError(`"${resourceId}"`) : new TablesError("FORBIDDEN", `your role is ${role}, and this needs more`);
  }

  /** Sharing refuses with a plain error. Turn its refusals into answers a client can read. */
  async function shared<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof Error && error.message === "forbidden") throw new TablesError("FORBIDDEN", "your role does not allow this");
      if (error instanceof Error && /^(invalid role|invalid subject|invalid resource|the last owner)/.test(error.message)) throw new TablesError("BAD_REQUEST", error.message);
      throw error;
    }
  }

  return (ctx: PrincipalContext) => {
    // Roles belong to the root of the chain. The leaf is who acted, and it stays on every row.
    const root = ctx.chain[0]!;
    const owner: Actor = { id: root.id, kind: root.kind };
    const actor: Actor = { id: ctx.principalId, kind: ctx.kind };
    const tableOfRow = async (rowId: string) => (await tables.getRow(rowId)).tableId;
    const tableOfView = async (viewId: string) => (await tables.getView(viewId)).tableId;
    const onBase = async <T>(action: Action, baseId: string, run: () => Promise<T>): Promise<T> => (await need(ctx, action, baseId, "base"), run());
    const onTable = async <T>(action: Action, tableId: string, run: () => Promise<T>): Promise<T> => (await need(ctx, action, tableId, "table"), run());
    const onRow = async <T>(action: Action, rowId: string, run: () => Promise<T>): Promise<T> => (await need(ctx, action, await tableOfRow(rowId), "table"), run());
    const onView = async <T>(action: Action, viewId: string, run: () => Promise<T>): Promise<T> => (await need(ctx, action, await tableOfView(viewId), "table"), run());

    return {
      async createBase(name: string) {
        if (!hasScope(ctx.scopes, "base:write")) throw new TablesError("FORBIDDEN", "this credential cannot create a base");
        const base = await tables.createBase(name, owner);
        try {
          await shared(() => sharing.createResource(ctx, { id: base.id, type: "base" }));
        } catch (error) {
          await tables.deleteBase(base.id);
          throw error;
        }
        return base;
      },
      /** The bases the caller can read. Each check writes an audit entry. */
      async listBases() {
        const out = [];
        for (const base of await tables.listBases()) if ((await sharing.can(ctx, "read", base.id)).allowed) out.push(base);
        return out;
      },
      async deleteBase(baseId: string) {
        return onBase("admin", baseId, () => tables.deleteBase(baseId));
      },

      async createTable(baseId: string, name: string, fields: FieldInput[] = []) {
        await need(ctx, "write", baseId, "base");
        const table = await tables.createTable(baseId, name, fields);
        try {
          await shared(() => sharing.createResource(ctx, { id: table.id, type: "table", parentId: baseId }));
        } catch (error) {
          await tables.deleteTable(table.id);
          throw error;
        }
        return table;
      },
      async listTables(baseId: string) {
        return onBase("read", baseId, () => tables.listTables(baseId));
      },
      getTable: (tableId: string) => onTable("read", tableId, () => tables.getTable(tableId)),
      deleteTable: (tableId: string) => onTable("admin", tableId, () => tables.deleteTable(tableId)),

      addField: (tableId: string, input: AddFieldInput) => onTable("admin", tableId, () => tables.addField(tableId, input)),
      renameField: (tableId: string, ref: string, name: string) => onTable("admin", tableId, () => tables.renameField(tableId, ref, name)),
      deleteField: (tableId: string, ref: string) => onTable("admin", tableId, () => tables.deleteField(tableId, ref)),
      changeFieldType: (tableId: string, ref: string, change: ChangeTypeOptions) => onTable("admin", tableId, () => tables.changeFieldType(tableId, ref, change)),
      setRequired: (tableId: string, ref: string, required: boolean, opts: { dryRun?: boolean } = {}) => onTable("admin", tableId, () => tables.setRequired(tableId, ref, required, opts)),
      setOptions: (tableId: string, ref: string, options: string[], opts: { onInUse?: "abort" | "clear" } = {}) => onTable("admin", tableId, () => tables.setOptions(tableId, ref, options, opts)),

      insertRow: (tableId: string, values: Values) => onTable("write", tableId, () => tables.insertRow(tableId, values, actor)),
      insertRows: (tableId: string, list: Values[]) => onTable("write", tableId, () => tables.insertRows(tableId, list, actor)),
      updateRow: (rowId: string, values: Values) => onRow("write", rowId, () => tables.updateRow(rowId, values, actor)),
      deleteRow: (rowId: string) => onRow("write", rowId, () => tables.deleteRow(rowId)),
      getRow: (rowId: string) => onRow("read", rowId, () => tables.getRow(rowId)),
      listRows: (tableId: string, options: ListRowsOptions = {}) => onTable("read", tableId, () => tables.listRows(tableId, options)),
      queryRows: (tableId: string, query: RowQuery = {}) => onTable("read", tableId, () => tables.queryRows(tableId, query)),

      createView: (tableId: string, input: ViewInput) => onTable("write", tableId, () => tables.createView(tableId, input)),
      listViews: (tableId: string) => onTable("read", tableId, () => tables.listViews(tableId)),
      deleteView: (viewId: string) => onView("write", viewId, () => tables.deleteView(viewId)),
      runView: (viewId: string, run: { limit?: number; cursor?: string } = {}) => onView("read", viewId, () => tables.runView(viewId, run)),

      /** Give `subjectId` a role on a base or a table. Needs owner. No role at all: not found. */
      grant: async (type: "base" | "table", resourceId: string, subjectId: string, role: Role) => {
        await need(ctx, "admin", resourceId, type);
        await shared(() => sharing.grant(ctx, resourceId, subjectId, role));
      },
      revokeGrant: async (type: "base" | "table", resourceId: string, subjectId: string) => {
        await need(ctx, "admin", resourceId, type);
        await shared(() => sharing.revokeGrant(ctx, resourceId, subjectId));
      },

      /** Export or erase the data of the caller. Only a root principal may: an agent must not export or erase its owner's data. */
      async exportMyData() {
        return tables.exportOwnerData(selfOnly().id);
      },
      async eraseMyData() {
        return tables.eraseOwnerData(selfOnly().id);
      },
    };

    function selfOnly(): Actor {
      if (ctx.chain.length !== 1) throw new TablesError("FORBIDDEN", "only the person or agent itself can export or erase its own data");
      return owner;
    }
  };
}

export type Guarded = ReturnType<ReturnType<typeof createGuarded>>;
