import { assertId, createSharing, hasScope, type Action, type PrincipalContext, type Role } from "agentic-identity";
import { NotFoundError, TablesError, type Actor, type FieldInput, type Values } from "./model.js";
import type { AddFieldInput, ChangeTypeOptions, ListRowsOptions, RowQuery, Tables, ViewInput } from "./tables.js";

export type Sharing = ReturnType<typeof createSharing>;

/** The ids that sharing accepts as a subject. */
const SUBJECT = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Tables with access checks. A base and a table are shared resources (a table sits inside its base), so a
 * role on a base passes down to its tables. `forCaller` gives the API of `Tables` for one caller. Each call
 * asks `can()` first. `can()` writes an audit entry for every allow and every deny.
 *
 * Needs: read to look, write for rows, views, and new tables, admin (owner) to change a schema or delete.
 * A caller with no role at all gets "not found", so a stranger cannot learn that an id exists.
 */
export function createGuarded(tables: Tables, sharing: Sharing) {
  const missing = () => new NotFoundError("that resource");
  /** A credential without the scope is refused by name. This is checked first and does not depend on the id, so it tells nothing about the id. */
  function scoped(ctx: PrincipalContext, action: Action, type: "base" | "table"): void {
    if (!hasScope(ctx.scopes, `${type}:${action}`)) throw new TablesError("FORBIDDEN", `this credential does not allow ${action} on a ${type}`);
  }
  async function need(ctx: PrincipalContext, action: Action, resourceId: string, type: "base" | "table"): Promise<void> {
    scoped(ctx, action, type);
    try {
      assertId(resourceId);
    } catch {
      throw missing();
    }
    const { allowed, role } = await sharing.can(ctx, action, resourceId);
    if (allowed) return;
    // A role that is too low is refused by name. No role at all looks the same as an id that does not exist.
    throw role === undefined ? missing() : new TablesError("FORBIDDEN", `your role is ${role}, and this needs more`);
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
    // The scope is checked before the lookup, and a failed lookup looks like no role, so neither shows if an id exists.
    const tableOfRow = async (rowId: string) => (await tables.getRow(rowId).catch(() => Promise.reject(missing()))).tableId;
    const tableOfView = async (viewId: string) => (await tables.getView(viewId).catch(() => Promise.reject(missing()))).tableId;
    /**
     * A link value that names a row tells whether the row exists, so the caller needs to read the linked table. Null and an
     * empty list name no row. Each key is matched to a field the way `Tables` does (id first, then name), and every key counts:
     * a body may carry one field under two keys.
     */
    const linkValues = async (tableId: string, lists: Values[]) => {
      const table = await tables.getTable(tableId);
      const needed = new Set<string>();
      for (const values of lists) {
        for (const [key, value] of Object.entries(values)) {
          const field = table.fields.find((f) => f.id === key) ?? table.fields.find((f) => f.name === key);
          const names = Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null;
          if (field?.type === "link" && field.linkTable !== undefined && names) needed.add(field.linkTable);
        }
      }
      for (const linkTable of needed) await need(ctx, "read", linkTable, "table");
    };
    const linkTargets = async (inputs: { type: string; linkTable?: string }[]) => {
      // A link field names a table, and the caller learns that table exists when the field is accepted.
      for (const input of inputs) if (input.type === "link" && input.linkTable !== undefined) await need(ctx, "read", input.linkTable, "table");
    };
    const onBase = async <T>(action: Action, baseId: string, run: () => Promise<T>): Promise<T> => (await need(ctx, action, baseId, "base"), run());
    const onTable = async <T>(action: Action, tableId: string, run: () => Promise<T>): Promise<T> => (await need(ctx, action, tableId, "table"), run());
    const onRow = async <T>(action: Action, rowId: string, run: () => Promise<T>): Promise<T> => (scoped(ctx, action, "table"), await need(ctx, action, await tableOfRow(rowId), "table"), run());
    const onView = async <T>(action: Action, viewId: string, run: () => Promise<T>): Promise<T> => (scoped(ctx, action, "table"), await need(ctx, action, await tableOfView(viewId), "table"), run());

    return {
      async createBase(name: string) {
        if (!hasScope(ctx.scopes, "base:write")) throw new TablesError("FORBIDDEN", "this credential cannot create a base");
        await noLegacyBases();
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
        await need(ctx, "admin", baseId, "base");
        await linkTargets(fields);
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

      addField: (tableId: string, input: AddFieldInput) => onTable("admin", tableId, async () => (await linkTargets([input]), tables.addField(tableId, input))),
      renameField: (tableId: string, ref: string, name: string) => onTable("admin", tableId, () => tables.renameField(tableId, ref, name)),
      deleteField: (tableId: string, ref: string) => onTable("admin", tableId, () => tables.deleteField(tableId, ref)),
      changeFieldType: (tableId: string, ref: string, change: ChangeTypeOptions) =>
        onTable("admin", tableId, async () => (await linkTargets([{ type: change.to, linkTable: change.linkTable }]), tables.changeFieldType(tableId, ref, change))),
      setRequired: (tableId: string, ref: string, required: boolean, opts: { dryRun?: boolean } = {}) => onTable("admin", tableId, () => tables.setRequired(tableId, ref, required, opts)),
      setOptions: (tableId: string, ref: string, options: string[], opts: { onInUse?: "abort" | "clear" } = {}) => onTable("admin", tableId, () => tables.setOptions(tableId, ref, options, opts)),

      insertRow: (tableId: string, values: Values) => onTable("write", tableId, async () => (await linkValues(tableId, [values]), tables.insertRow(tableId, values, actor))),
      insertRows: (tableId: string, list: Values[]) => onTable("write", tableId, async () => (await linkValues(tableId, list), tables.insertRows(tableId, list, actor))),
      updateRow: (rowId: string, values: Values) => onRow("write", rowId, async () => (await linkValues((await tables.getRow(rowId)).tableId, [values]), tables.updateRow(rowId, values, actor))),
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
      /**
       * Take a role back. On a base it also takes back the role on each table in it, such as the owner role of a table the person made.
       * The caller first becomes a direct owner of each table, so the person is never its last owner, then every grant goes. If a step
       * fails, call again: the steps repeat without harm.
       */
      revokeGrant: async (type: "base" | "table", resourceId: string, subjectId: string) => {
        await need(ctx, "admin", resourceId, type);
        if (!SUBJECT.test(subjectId)) throw new TablesError("BAD_REQUEST", "invalid subject");
        if (type === "base") {
          scoped(ctx, "admin", "table");
          const inBase = await tables.listTables(resourceId);
          if (inBase.length > 0 && subjectId === owner.id) throw new TablesError("BAD_REQUEST", "ask another owner to remove you from a base that has tables");
          for (const table of inBase) await shared(() => sharing.grant(ctx, table.id, owner.id, "owner"));
          for (const table of inBase) await shared(() => sharing.revokeGrant(ctx, table.id, subjectId));
        }
        await shared(() => sharing.revokeGrant(ctx, resourceId, subjectId));
      },

      /**
       * Claim a base that an earlier version made: the caller states its own kind as the owner, and the base and its tables become
       * shared resources the caller owns. Only a root principal can, and only for a base that carries its own id. If a step fails, call again. A claim that succeeded cannot be repeated.
       */
      async claimBase(baseId: string) {
        selfOnly("admin");
        if (!(await tables.legacyBaseIds(owner.id)).includes(baseId)) throw missing();
        /** True when the resource is new. A resource that exists is left as it is. */
        const register = (id: string, parentId?: string) =>
          shared(() => sharing.createResource(ctx, { id, type: parentId === undefined ? "base" : "table", ...(parentId === undefined ? {} : { parentId }) })).then(
            () => true,
            (error: unknown) => {
              if (error instanceof Error && error.message === "resource exists") return false;
              throw error;
            },
          );
        // A base with a sharing record was made by a build that had sharing but no owner kind. Its owner may have given it away. Then the
        // caller has no right to register a table, and the tables are registered already, so the claim only records the kind.
        const registered = !(await register(baseId));
        for (const table of await tables.listTables(baseId)) {
          await register(table.id, baseId).catch((error: unknown) => {
            if (!(registered && error instanceof TablesError && error.code === "FORBIDDEN")) throw error;
          });
        }
        await tables.setLegacyBaseOwnerKind(baseId, owner);
        return { baseId, owner };
      },

      /**
       * Export or erase the data of the caller. Only a root principal may: an agent must not export or erase its owner's data.
       * Only the bases the caller owns and still holds the owner role on are touched: a base the caller gave away is not theirs to erase.
       */
      async exportMyData() {
        const me = selfOnly("admin");
        await noLegacyBases();
        return tables.exportOwnerData(me, { baseIds: await ownedBases() });
      },
      async eraseMyData() {
        const me = selfOnly("admin");
        await noLegacyBases();
        return tables.eraseOwnerData(me, { baseIds: await ownedBases() });
      },
    };

    /**
     * A base made by an earlier version has this owner id and no owner kind. Export and erase would pass it over and report success,
     * and a new base would hide it, so they all stop until each one is claimed.
     */
    async function noLegacyBases(): Promise<void> {
      const ids = await tables.legacyBaseIds(owner.id);
      if (ids.length > 0) throw new TablesError("LEGACY_BASE", `bases ${ids.join(", ")} were made by an earlier version and have no owner kind. Claim each one first`);
    }

    async function ownedBases(): Promise<string[]> {
      const ids = [];
      for (const base of await tables.listBases()) if (base.ownerId === owner.id && base.ownerKind === owner.kind && (await sharing.can(ctx, "admin", base.id)).allowed) ids.push(base.id);
      return ids;
    }
    function selfOnly(action: Action): Actor {
      scoped(ctx, action, "base");
      if (ctx.chain.length !== 1) throw new TablesError("FORBIDDEN", "only the person or agent itself can export or erase its own data");
      return owner;
    }
  };
}

export type Guarded = ReturnType<ReturnType<typeof createGuarded>>;
