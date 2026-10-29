import { deriveOptions, MigrationError, planConversion, type MigrationReport } from "./migrate.js";
import {
  checkValue,
  isEmpty,
  FIELD_TYPES,
  NotFoundError,
  PRINCIPAL_KINDS,
  ValidationError,
  type Actor,
  type Field,
  type FieldInput,
  type FieldType,
  type Issue,
  type Row,
  type Table,
  TablesError,
  type Values,
} from "./model.js";
import type { Doc, Json, Page, Store, StoreOps } from "agentic-identity";
import { compareKeys, decodeCursor, encodeCursor, matches, resolveFilter, resolveSort, sortKey, type Filter, type Sort, type SortSpec } from "./query.js";

export interface Base {
  id: string;
  name: string;
  /** The id of the principal that owns the base. Export and erase work by this id. */
  ownerId: string;
  createdAt: string;
}

/** Everything one owner holds, as JSON. Row values are keyed by field name. */
export interface OwnerExport {
  format: "agentic-tables-export";
  version: 1;
  exportedAt: string;
  ownerId: string;
  bases: { base: Base; tables: Table[]; views: View[]; rows: Row[] }[];
  /** Rows this principal wrote in bases it does not own. */
  authoredRows: Row[];
}

export interface EraseSummary {
  bases: number;
  tables: number;
  rows: number;
  views: number;
  /** Rows this principal wrote in bases it does not own. They are not part of `rows`. */
  authoredRows: number;
}

export interface TablesOptions {
  /** The most rows a filtered or field-sorted query may read. A larger table fails the query. Defaults to 10000. */
  maxScan?: number;
  /** Clock in epoch milliseconds. Tests set it. */
  now?: () => number;
  /** Id source. Defaults to a random id with the prefix. */
  newId?: (prefix: string) => string;
}

export interface AddFieldInput extends FieldInput {
  /** Backfills existing rows. A required field needs it when rows exist. */
  default?: Json;
}

export interface ChangeTypeOptions {
  to: FieldType;
  /** Select targets. Defaults to the distinct stored values. */
  options?: string[];
  linkTable?: string;
  /** "abort" (default) changes nothing when a value fails. "clear" empties failed values. */
  onFailure?: "abort" | "clear";
  dryRun?: boolean;
}

export interface RowQuery {
  filter?: Filter;
  sort?: Sort;
  /** 1 to 1000. Defaults to 100. */
  limit?: number;
  cursor?: string;
}

export interface RowPage {
  items: Row[];
  nextCursor?: string;
  /** "store": the store ran the whole query. "memory": rows were read, then filtered and sorted here. */
  plan: "store" | "memory";
}

export type ViewKind = "grid" | "board";

export interface ViewInput {
  name: string;
  kind: ViewKind;
  filter?: Filter;
  sort?: Sort;
  /** Board only. A single select field. */
  groupBy?: string;
}

export interface View {
  id: string;
  tableId: string;
  name: string;
  kind: ViewKind;
  /** Field ids, so a rename keeps the view working. */
  filter?: Filter;
  sort?: Sort;
  groupBy?: string;
}

export type ViewRun =
  | ({ kind: "grid" } & RowPage)
  | { kind: "board"; groupBy: string; groups: { value: string | null; count: number; rows: Row[] }[] };

export interface ListRowsOptions {
  limit?: number;
  cursor?: string;
}

interface TableDoc {
  baseId: string;
  name: string;
  fields: Field[];
  createdAt: string;
  updatedAt: string;
}

interface RowDoc {
  tableId: string;
  baseId: string;
  values: Record<string, Json>;
  createdAt: string;
  updatedAt: string;
  createdBy: Actor;
  updatedBy: Actor;
}

const read = async <T>(ops: StoreOps, collection: string, id: string): Promise<T | null> => (await ops.get(collection, id)) as unknown as T | null;
const write = (ops: StoreOps, collection: string, id: string, doc: object): Promise<void> => ops.put(collection, id, doc as Doc);

/**
 * A write that waits. The Store port refuses a read after a write inside a transaction, so a change
 * first reads everything and builds a list of these, then applies the list. A doc is null to delete.
 */
type Write = [collection: string, id: string, doc: object | null];
const apply = async (ops: StoreOps, writes: Write[]): Promise<void> => {
  for (const [collection, id, doc] of writes) await (doc === null ? ops.delete(collection, id) : write(ops, collection, id, doc));
};

async function all<T>(ops: StoreOps, collection: string, where: Record<string, string>, orderField: string, max = Infinity): Promise<{ id: string; data: T }[]> {
  const out: { id: string; data: T }[] = [];
  let cursor: string | undefined;
  do {
    const page: Page = await ops.query(collection, { where, orderBy: { field: orderField }, limit: 500, cursor });
    out.push(...page.items.map((e) => ({ id: e.id, data: e.data as unknown as T })));
    if (out.length > max) throw new TablesError("SCAN_LIMIT", `the query needs more than ${max} rows. Narrow the table or raise maxScan`);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return out;
}

const checkDirection = (sort: Sort | undefined, issues: Issue[]): void => {
  if (sort?.direction !== undefined && sort.direction !== "asc" && sort.direction !== "desc") issues.push({ field: "direction", code: "type", message: 'must be "asc" or "desc"' });
};

const assertOwnerId = (ownerId: unknown): void => {
  if (typeof ownerId !== "string" || ownerId === "") throw new TablesError("BAD_REQUEST", "an owner id is required");
};

const findField = (table: TableDoc, ref: string): Field => {
  const field = table.fields.find((f) => f.id === ref) ?? table.fields.find((f) => f.name === ref);
  if (!field) throw new NotFoundError(`field "${ref}"`);
  return field;
};

function checkFields(inputs: FieldInput[], taken: string[], issues: Issue[]): void {
  const names = taken.map((n) => n.trim().toLowerCase());
  for (const input of inputs) {
    const at = (code: Issue["code"], message: string) => issues.push({ field: input.name, code, message });
    const key = typeof input.name === "string" ? input.name.trim().toLowerCase() : "";
    if (key === "") at("type", "needs a name");
    else if (names.includes(key)) at("duplicate_field", "a field with this name exists");
    names.push(key);
    if (!FIELD_TYPES.includes(input.type)) at("type", `type must be one of ${FIELD_TYPES.join(", ")}`);
    const select = input.type === "single_select" || input.type === "multi_select";
    if (select && (!Array.isArray(input.options) || new Set(input.options).size !== input.options.length || input.options.some((o) => o.trim() === "")))
      at("option", "needs a list of unique, non-empty options");
    if (input.type === "link" && !input.linkTable) at("type", "needs linkTable");
  }
}

export function createTables(store: Store, options: TablesOptions = {}) {
  let last = 0;
  const stamp = (): string => {
    last = Math.max(last + 1, options.now?.() ?? Date.now());
    return new Date(last).toISOString();
  };
  const newId = options.newId ?? ((prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`);

  const loadTable = async (ops: StoreOps, id: string): Promise<TableDoc> => {
    const doc = await read<TableDoc>(ops, "tables", id);
    if (!doc) throw new NotFoundError(`table "${id}"`);
    return doc;
  };
  const tableView = (id: string, doc: TableDoc): Table => ({ id, ...doc });
  const rowView = (table: TableDoc, id: string, doc: RowDoc): Row => ({
    id,
    tableId: doc.tableId,
    values: Object.fromEntries(table.fields.filter((f) => f.id in doc.values).map((f) => [f.name, doc.values[f.id] as Json])),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    createdBy: doc.createdBy,
    updatedBy: doc.updatedBy,
  });
  const assertActor = (actor: Actor): void => {
    if (typeof actor?.id !== "string" || actor.id === "" || !PRINCIPAL_KINDS.includes(actor.kind)) throw new Error("actor needs an id and a valid kind");
  };
  const checkLinkTables = async (ops: StoreOps, baseId: string, inputs: FieldInput[], issues: Issue[]): Promise<void> => {
    for (const input of inputs) {
      if (input.type !== "link" || !input.linkTable) continue;
      const target = await read<TableDoc>(ops, "tables", input.linkTable);
      if (target?.baseId !== baseId) issues.push({ field: input.name, code: "type", message: "linkTable must be a table in the same base" });
    }
  };
  const toField = (input: FieldInput): Field => ({
    id: newId("fld"),
    name: input.name.trim(),
    type: input.type,
    required: input.required ?? false,
    ...(input.options ? { options: [...input.options] } : {}),
    ...(input.linkTable ? { linkTable: input.linkTable } : {}),
  });

  /** Check input values and merge them into the stored ones. Keys are field names or ids. */
  const merge = async (ops: StoreOps, table: TableDoc, existing: Record<string, Json>, input: Values): Promise<Record<string, Json>> => {
    const issues: Issue[] = [];
    const merged = { ...existing };
    for (const [key, value] of Object.entries(input)) {
      const field = table.fields.find((f) => f.id === key) ?? table.fields.find((f) => f.name === key);
      if (!field) {
        issues.push({ field: key, code: "unknown_field", message: "no such field" });
        continue;
      }
      const issue = checkValue(field, value);
      if (issue) issues.push({ field: field.name, ...issue });
      else if (field.type === "link" && Array.isArray(value)) {
        for (const id of value as string[]) {
          const target = await read<RowDoc>(ops, "rows", id);
          if (target?.tableId !== field.linkTable) issues.push({ field: field.name, code: "link_missing", message: `row "${id}" is not in the linked table` });
        }
      }
      merged[field.id] = value ?? null;
    }
    for (const field of table.fields) {
      if (field.required && isEmpty(merged[field.id])) issues.push({ field: field.name, code: "required", message: "is required" });
    }
    if (issues.length > 0) throw new ValidationError(issues);
    return merged;
  };

  const requiredNoClear = (field: Field): Issue => ({ field: field.name, code: "required", message: "is required, so a value cannot be cleared. Make the field optional first" });

  const planRewrite = async (ops: StoreOps, tableId: string, change: (doc: RowDoc, id: string) => Record<string, Json> | null, rows?: { id: string; data: RowDoc }[]): Promise<Write[]> => {
    const writes: Write[] = [];
    for (const { id, data } of rows ?? (await all<RowDoc>(ops, "rows", { tableId }, "createdAt"))) {
      const values = change(data, id);
      if (values) writes.push(["rows", id, { ...data, values }]);
    }
    return writes;
  };
  const planDropTable = async (ops: StoreOps, tableId: string): Promise<{ writes: Write[]; rows: number; views: number }> => {
    const rows = await all<RowDoc>(ops, "rows", { tableId }, "createdAt");
    const views = await all<object>(ops, "views", { tableId }, "createdAt");
    const writes: Write[] = [...rows.map(({ id }): Write => ["rows", id, null]), ...views.map(({ id }): Write => ["views", id, null]), ["tables", tableId, null]];
    return { writes, rows: rows.length, views: views.length };
  };
  /** Delete rows and remove their ids from every link that points at them. One pass, so a deleted row is never rewritten. */
  const planRemoveRows = async (ops: StoreOps, doomed: { id: string; data: RowDoc }[]): Promise<Write[]> => {
    const gone = new Set(doomed.map((r) => r.id));
    const writes: Write[] = [];
    for (const baseId of new Set(doomed.map((r) => r.data.baseId))) {
      const targets = new Set(doomed.filter((r) => r.data.baseId === baseId).map((r) => r.data.tableId));
      for (const { id: tableId, data: table } of await all<TableDoc>(ops, "tables", { baseId }, "createdAt")) {
        const links = table.fields.filter((f) => f.type === "link" && f.linkTable !== undefined && targets.has(f.linkTable));
        if (links.length === 0) continue;
        writes.push(
          ...(await planRewrite(ops, tableId, (doc, id) => {
            if (gone.has(id)) return null;
            const hit = links.filter((f) => (doc.values[f.id] as string[] | undefined)?.some((x) => gone.has(x)));
            return hit.length === 0 ? null : { ...doc.values, ...Object.fromEntries(hit.map((f) => [f.id, (doc.values[f.id] as string[]).filter((x) => !gone.has(x))])) };
          })),
        );
      }
    }
    return [...writes, ...doomed.map((r): Write => ["rows", r.id, null])];
  };
  /** Rows the principal wrote in bases it does not own, with the table of each. */
  const authoredElsewhere = async (ops: StoreOps, principalId: string): Promise<{ id: string; data: RowDoc; table: TableDoc }[]> => {
    const found: { id: string; data: RowDoc; table: TableDoc }[] = [];
    for (const base of await all<{ ownerId?: string }>(ops, "bases", {}, "createdAt")) {
      if (base.data.ownerId === principalId) continue;
      for (const { id: tableId, data: table } of await all<TableDoc>(ops, "tables", { baseId: base.id }, "createdAt")) {
        for (const r of await all<RowDoc>(ops, "rows", { tableId }, "createdAt")) if (r.data.createdBy?.id === principalId) found.push({ ...r, table });
      }
    }
    return found;
  };
  const planDropBase = async (ops: StoreOps, baseId: string): Promise<{ writes: Write[]; summary: EraseSummary }> => {
    const summary: EraseSummary = { bases: 1, tables: 0, rows: 0, views: 0, authoredRows: 0 };
    const writes: Write[] = [];
    for (const { id } of await all<TableDoc>(ops, "tables", { baseId }, "createdAt")) {
      const gone = await planDropTable(ops, id);
      writes.push(...gone.writes);
      summary.tables += 1;
      summary.rows += gone.rows;
      summary.views += gone.views;
    }
    return { writes: [...writes, ["bases", baseId, null]], summary };
  };
  /** The table doc as it will be stored, with its new fields. */
  const changed = (table: TableDoc, fields: Field[]): TableDoc => ({ ...table, fields, updatedAt: stamp() });

  const report = (field: Field, to: FieldType, rows: { id: string; value: Json | undefined }[]): MigrationReport => ({
    field: field.name, from: field.type, to, total: rows.length, empty: rows.filter((r) => isEmpty(r.value)).length, converted: 0, failures: [], droppedOptions: [], applied: false,
  });

  const scanRows = async (table: Table, filter: Filter | undefined, spec: SortSpec | undefined, direction: "asc" | "desc") => {
    const rows = await all<RowDoc>(store, "rows", { tableId: table.id }, "createdAt", options.maxScan ?? 10_000);
    return rows
      .filter((r) => !filter || matches(table, filter, r.data.values))
      .map((r) => ({ ...r, k: sortKey(spec ?? { system: "createdAt" }, r.data), at: r.data.createdAt }))
      .sort((a, b) => compareKeys(a, b, direction));
  };

  return {
    async createBase(name: string, owner: Actor): Promise<Base> {
      assertActor(owner);
      if (name.trim() === "") throw new Error("base needs a name");
      const base = { id: newId("base"), name: name.trim(), ownerId: owner.id, createdAt: stamp() };
      await write(store, "bases", base.id, { name: base.name, ownerId: base.ownerId, createdAt: base.createdAt });
      return base;
    },
    async listBases(): Promise<Base[]> {
      return (await all<Omit<Base, "id">>(store, "bases", {}, "createdAt")).map((e) => ({ id: e.id, ...e.data }));
    },

    /** Export every base the principal owns, and every row it wrote in other bases, in one consistent read. Memory grows with the data. */
    async exportOwnerData(ownerId: string): Promise<OwnerExport> {
      assertOwnerId(ownerId);
      return store.transaction(async (ops) => {
        const bases: OwnerExport["bases"] = [];
        for (const owned of await all<Omit<Base, "id">>(ops, "bases", { ownerId }, "createdAt")) {
          const out: OwnerExport["bases"][number] = { base: { id: owned.id, ...owned.data }, tables: [], views: [], rows: [] };
          for (const { id, data } of await all<TableDoc>(ops, "tables", { baseId: owned.id }, "createdAt")) {
            out.tables.push(tableView(id, data));
            for (const r of await all<RowDoc>(ops, "rows", { tableId: id }, "createdAt")) out.rows.push(rowView(data, r.id, r.data));
            for (const v of await all<Omit<View, "id">>(ops, "views", { tableId: id }, "createdAt")) out.views.push({ id: v.id, ...v.data });
          }
          bases.push(out);
        }
        const authoredRows = (await authoredElsewhere(ops, ownerId)).map((r) => rowView(r.table, r.id, r.data));
        return { format: "agentic-tables-export", version: 1, exportedAt: stamp(), ownerId, bases, authoredRows };
      });
    },
    /** Hard delete every base the principal owns and every row it wrote in other bases. No copy stays in the store. Other rows in those bases stay. */
    async eraseOwnerData(ownerId: string): Promise<EraseSummary> {
      assertOwnerId(ownerId);
      return store.transaction(async (ops) => {
        const total: EraseSummary = { bases: 0, tables: 0, rows: 0, views: 0, authoredRows: 0 };
        const writes: Write[] = [];
        for (const { id } of await all<object>(ops, "bases", { ownerId }, "createdAt")) {
          const gone = await planDropBase(ops, id);
          writes.push(...gone.writes);
          total.bases += 1;
          total.tables += gone.summary.tables;
          total.rows += gone.summary.rows;
          total.views += gone.summary.views;
        }
        const authored = await authoredElsewhere(ops, ownerId);
        writes.push(...(await planRemoveRows(ops, authored)));
        total.authoredRows = authored.length;
        await apply(ops, writes);
        return total;
      });
    },

    async createTable(baseId: string, name: string, fields: FieldInput[] = []): Promise<Table> {
      return store.transaction(async (ops) => {
        if (!(await read(ops, "bases", baseId))) throw new NotFoundError(`base "${baseId}"`);
        const issues: Issue[] = [];
        checkFields(fields, [], issues);
        await checkLinkTables(ops, baseId, fields, issues);
        if (issues.length > 0) throw new ValidationError(issues);
        const at = stamp();
        const doc: TableDoc = { baseId, name: name.trim(), fields: fields.map(toField), createdAt: at, updatedAt: at };
        const id = newId("tbl");
        await write(ops, "tables", id, doc);
        return tableView(id, doc);
      });
    },
    async getTable(tableId: string): Promise<Table> {
      return tableView(tableId, await loadTable(store, tableId));
    },
    async listTables(baseId: string): Promise<Table[]> {
      return (await all<TableDoc>(store, "tables", { baseId }, "createdAt")).map((e) => tableView(e.id, e.data));
    },

    async insertRow(tableId: string, values: Values, actor: Actor): Promise<Row> {
      assertActor(actor);
      return store.transaction(async (ops) => {
        const table = await loadTable(ops, tableId);
        const at = stamp();
        const doc: RowDoc = { tableId, baseId: table.baseId, values: await merge(ops, table, {}, values), createdAt: at, updatedAt: at, createdBy: actor, updatedBy: actor };
        const id = newId("row");
        await write(ops, "rows", id, doc);
        return rowView(table, id, doc);
      });
    },
    /** Insert many rows in one transaction. If any row fails, none is written. A failure names the row, as "row 2.Age". */
    async insertRows(tableId: string, list: Values[], actor: Actor): Promise<Row[]> {
      assertActor(actor);
      return store.transaction(async (ops) => {
        const table = await loadTable(ops, tableId);
        const docs: { id: string; doc: RowDoc }[] = [];
        for (const [i, values] of list.entries()) {
          const at = stamp();
          let merged: Record<string, Json>;
          try {
            merged = await merge(ops, table, {}, values);
          } catch (error) {
            if (error instanceof ValidationError) throw new ValidationError(error.issues.map((x) => ({ ...x, field: `row ${i + 1}.${x.field}` })));
            throw error;
          }
          const doc: RowDoc = { tableId, baseId: table.baseId, values: merged, createdAt: at, updatedAt: at, createdBy: actor, updatedBy: actor };
          docs.push({ id: newId("row"), doc });
        }
        await apply(ops, docs.map(({ id, doc }): Write => ["rows", id, doc]));
        return docs.map(({ id, doc }) => rowView(table, id, doc));
      });
    },
    async updateRow(rowId: string, values: Values, actor: Actor): Promise<Row> {
      assertActor(actor);
      return store.transaction(async (ops) => {
        const current = await read<RowDoc>(ops, "rows", rowId);
        if (!current) throw new NotFoundError(`row "${rowId}"`);
        const table = await loadTable(ops, current.tableId);
        const doc: RowDoc = { ...current, values: await merge(ops, table, current.values, values), updatedAt: stamp(), updatedBy: actor };
        await write(ops, "rows", rowId, doc);
        return rowView(table, rowId, doc);
      });
    },
    async getRow(rowId: string): Promise<Row> {
      const doc = await read<RowDoc>(store, "rows", rowId);
      if (!doc) throw new NotFoundError(`row "${rowId}"`);
      return rowView(await loadTable(store, doc.tableId), rowId, doc);
    },
    async listRows(tableId: string, listOptions: ListRowsOptions = {}): Promise<{ items: Row[]; nextCursor?: string }> {
      const table = await loadTable(store, tableId);
      const page = await store.query("rows", { where: { tableId }, orderBy: { field: "createdAt" }, limit: listOptions.limit, cursor: listOptions.cursor });
      return { items: page.items.map((e) => rowView(table, e.id, e.data as unknown as RowDoc)), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
    },
    /**
     * Filter, sort, and page rows. With no filter and no field sort, the store runs the whole query:
     * an equality filter on the table, one orderBy on createdAt or updatedAt, limit, and cursor.
     * Otherwise the rows of the table are read (up to maxScan), then filtered and sorted in memory.
     */
    async queryRows(tableId: string, q: RowQuery = {}): Promise<RowPage> {
      const limit = q.limit ?? 100;
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new TablesError("INVALID_QUERY", "limit must be an integer from 1 to 1000");
      const doc = await loadTable(store, tableId);
      const table = tableView(tableId, doc);
      const issues: Issue[] = [];
      const filter = q.filter ? resolveFilter(table, q.filter, issues) : undefined;
      const spec = q.sort ? resolveSort(table, q.sort, issues) : undefined;
      checkDirection(q.sort, issues);
      if (issues.length > 0) throw new ValidationError(issues);
      const direction = q.sort?.direction ?? "asc";
      if (!filter && (!spec || "system" in spec)) {
        const page = await store
          .query("rows", { where: { tableId }, orderBy: { field: spec ? spec.system : "createdAt", direction }, limit, cursor: q.cursor })
          .catch((error: unknown) => {
            throw q.cursor !== undefined && error instanceof Error && error.message === "invalid cursor" ? new TablesError("INVALID_CURSOR", "invalid cursor") : error;
          });
        return { items: page.items.map((e) => rowView(doc, e.id, e.data as unknown as RowDoc)), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}), plan: "store" };
      }
      const rows = await scanRows(table, filter, spec, direction);
      let start = 0;
      if (q.cursor !== undefined) {
        let after: [string | number | null, string, string];
        try {
          after = decodeCursor(q.cursor) as typeof after;
          if (!Array.isArray(after) || typeof after[2] !== "string") throw new Error();
        } catch {
          throw new TablesError("INVALID_CURSOR", "invalid cursor");
        }
        const at = rows.findIndex((r) => compareKeys(r, { k: after[0], at: after[1], id: after[2] }, direction) > 0);
        start = at === -1 ? rows.length : at;
      }
      const page = rows.slice(start, start + limit);
      const last = page[page.length - 1];
      return {
        items: page.map((r) => rowView(doc, r.id, r.data)),
        ...(start + limit < rows.length && last ? { nextCursor: encodeCursor([last.k, last.at, last.id]) } : {}),
        plan: "memory",
      };
    },

    async createView(tableId: string, input: ViewInput): Promise<View> {
      const table = tableView(tableId, await loadTable(store, tableId));
      const issues: Issue[] = [];
      const filter = input.filter ? resolveFilter(table, input.filter, issues) : undefined;
      const spec = input.sort ? resolveSort(table, input.sort, issues) : undefined;
      const group = input.groupBy ? table.fields.find((f) => f.id === input.groupBy || f.name === input.groupBy) : undefined;
      if (input.kind === "board" && group?.type !== "single_select") issues.push({ field: input.groupBy ?? "groupBy", code: "type", message: "a board needs groupBy set to a single select field" });
      if (input.name.trim() === "") issues.push({ field: "name", code: "type", message: "needs a name" });
      if (input.kind !== "grid" && input.kind !== "board") issues.push({ field: "kind", code: "type", message: 'must be "grid" or "board"' });
      checkDirection(input.sort, issues);
      if (issues.length > 0) throw new ValidationError(issues);
      const view: View = {
        id: newId("view"), tableId, name: input.name.trim(), kind: input.kind,
        ...(filter ? { filter } : {}),
        ...(input.sort ? { sort: { field: spec && "field" in spec ? spec.field.id : input.sort.field, direction: input.sort.direction ?? "asc" } } : {}),
        ...(group ? { groupBy: group.id } : {}),
      };
      const { id, ...rest } = view;
      await write(store, "views", id, { ...rest, createdAt: stamp() });
      return view;
    },
    async listViews(tableId: string): Promise<View[]> {
      return (await all<Omit<View, "id">>(store, "views", { tableId }, "createdAt")).map((e) => ({ id: e.id, ...e.data }));
    },
    async deleteView(viewId: string): Promise<void> {
      await store.delete("views", viewId);
    },
    /** Run a saved view. A grid returns a page. A board returns the rows of each option, with a group for no value. */
    async runView(viewId: string, run: { limit?: number; cursor?: string } = {}): Promise<ViewRun> {
      const view = await read<Omit<View, "id">>(store, "views", viewId);
      if (!view) throw new NotFoundError(`view "${viewId}"`);
      if (view.kind === "grid") return { kind: "grid", ...(await this.queryRows(view.tableId, { filter: view.filter, sort: view.sort, ...run })) };
      const doc = await loadTable(store, view.tableId);
      const table = tableView(view.tableId, doc);
      const issues: Issue[] = [];
      const filter = view.filter ? resolveFilter(table, view.filter, issues) : undefined;
      const spec = view.sort ? resolveSort(table, view.sort, issues) : undefined;
      const group = table.fields.find((f) => f.id === view.groupBy);
      if (!group) issues.push({ field: String(view.groupBy), code: "unknown_field", message: "no such field" });
      if (group && group.type !== "single_select") issues.push({ field: group.name, code: "type", message: `a board needs a single select field, and this one is now ${group.type}. Create a new view` });
      if (issues.length > 0 || !group) throw new ValidationError(issues);
      const rows = await scanRows(table, filter, spec, view.sort?.direction ?? "asc");
      const perGroup = run.limit ?? 50;
      if (!Number.isInteger(perGroup) || perGroup < 1 || perGroup > 1000) throw new TablesError("INVALID_QUERY", "limit must be an integer from 1 to 1000");
      const values: (string | null)[] = [...(group.options ?? []), null];
      return {
        kind: "board",
        groupBy: group.name,
        groups: values.map((value) => {
          const inGroup = rows.filter((r) => (r.data.values[group.id] ?? null) === value);
          return { value, count: inGroup.length, rows: inGroup.slice(0, perGroup).map((r) => rowView(doc, r.id, r.data)) };
        }),
      };
    },

    /** Delete a row and remove its id from every link that points at it. Cost grows with the rows of the tables that link here. */
    async deleteRow(rowId: string): Promise<void> {
      await store.transaction(async (ops) => {
        const row = await read<RowDoc>(ops, "rows", rowId);
        if (!row) throw new NotFoundError(`row "${rowId}"`);
        await apply(ops, await planRemoveRows(ops, [{ id: rowId, data: row }]));
      });
    },

    async addField(tableId: string, input: AddFieldInput): Promise<Table> {
      return store.transaction(async (ops) => {
        const table = await loadTable(ops, tableId);
        const issues: Issue[] = [];
        checkFields([input], table.fields.map((f) => f.name), issues);
        await checkLinkTables(ops, table.baseId, [input], issues);
        const field = toField(input);
        const rows = await all<RowDoc>(ops, "rows", { tableId }, "createdAt");
        const fill = input.default;
        if (!isEmpty(fill)) {
          const bad = checkValue(field, fill);
          if (bad) issues.push({ field: field.name, ...bad });
        } else if (field.required && rows.length > 0) {
          issues.push({ field: field.name, code: "required", message: `is required and ${rows.length} rows exist: pass a default` });
        }
        if (issues.length > 0) throw new ValidationError(issues);
        const next = changed(table, [...table.fields, field]);
        await apply(ops, [...(isEmpty(fill) ? [] : await planRewrite(ops, tableId, (doc) => ({ ...doc.values, [field.id]: fill as Json }), rows)), ["tables", tableId, next]]);
        return tableView(tableId, next);
      });
    },
    async renameField(tableId: string, ref: string, name: string): Promise<Table> {
      return store.transaction(async (ops) => {
        const table = await loadTable(ops, tableId);
        const field = findField(table, ref);
        const issues: Issue[] = [];
        checkFields([{ name, type: field.type, options: field.options, linkTable: field.linkTable }], table.fields.filter((f) => f !== field).map((f) => f.name), issues);
        if (issues.length > 0) throw new ValidationError(issues);
        const next = changed(table, table.fields.map((f) => (f === field ? { ...f, name: name.trim() } : f)));
        await write(ops, "tables", tableId, next);
        return tableView(tableId, next);
      });
    },
    async deleteField(tableId: string, ref: string): Promise<Table> {
      return store.transaction(async (ops) => {
        const table = await loadTable(ops, tableId);
        const field = findField(table, ref);
        const rewrites = await planRewrite(ops, tableId, (doc) => {
          if (!(field.id in doc.values)) return null;
          const { [field.id]: _gone, ...rest } = doc.values;
          return rest;
        });
        const next = changed(table, table.fields.filter((f) => f !== field));
        await apply(ops, [...rewrites, ["tables", tableId, next]]);
        return tableView(tableId, next);
      });
    },

    /** Change a field type. Every value converts or the change aborts. The report lists each row that fails. */
    async changeFieldType(tableId: string, ref: string, change: ChangeTypeOptions): Promise<MigrationReport> {
      return store.transaction(async (ops) => {
        const table = await loadTable(ops, tableId);
        const from = findField(table, ref);
        const rows = await all<RowDoc>(ops, "rows", { tableId }, "createdAt");
        const cells = rows.map((r) => ({ id: r.id, value: r.data.values[from.id] }));
        const select = change.to === "single_select" || change.to === "multi_select";
        const to: Field = {
          id: from.id, name: from.name, type: change.to, required: from.required,
          ...(select ? { options: change.options ?? deriveOptions([...(from.options ?? []), ...cells.map((c) => c.value).filter((v): v is Json => !isEmpty(v))], change.to) } : {}),
          ...(change.to === "link" && change.linkTable ? { linkTable: change.linkTable } : {}),
        };
        const issues: Issue[] = [];
        checkFields([to], [], issues);
        await checkLinkTables(ops, table.baseId, [to], issues);
        if (from.type === "link" && to.type === "link" && to.linkTable !== from.linkTable)
          issues.push({ field: from.name, code: "type", message: "cannot point a link at another table: the stored row ids belong to the old one. Add a new link field instead" });
        if (issues.length > 0) throw new ValidationError(issues);
        const plan = planConversion(cells, from, to);
        const clear = change.onFailure === "clear";
        if (plan.report.failures.length > 0 && !clear && !change.dryRun) throw new MigrationError(plan.report);
        if (change.dryRun) return plan.report;
        if (from.required && [...plan.next.values()].some(isEmpty)) throw new ValidationError([requiredNoClear(from)]);
        const rewrites = await planRewrite(ops, tableId, (doc, id) => (plan.next.has(id) ? { ...doc.values, [from.id]: plan.next.get(id) as Json } : null), rows);
        await apply(ops, [...rewrites, ["tables", tableId, changed(table, table.fields.map((f) => (f === from ? to : f)))]]);
        return { ...plan.report, applied: true };
      });
    },
    /** Delete a table with its rows and views. It is refused while another table has a link field that points at it. */
    async deleteTable(tableId: string): Promise<{ rows: number; views: number }> {
      return store.transaction(async (ops) => {
        const table = await loadTable(ops, tableId);
        const issues: Issue[] = [];
        for (const { id, data } of await all<TableDoc>(ops, "tables", { baseId: table.baseId }, "createdAt")) {
          if (id === tableId) continue;
          for (const f of data.fields) if (f.type === "link" && f.linkTable === tableId) issues.push({ field: `${data.name}.${f.name}`, code: "type", message: "links to this table. Delete that field first" });
        }
        if (issues.length > 0) throw new ValidationError(issues);
        const { writes, rows, views } = await planDropTable(ops, tableId);
        await apply(ops, writes);
        return { rows, views };
      });
    },
    /** Delete a base with all its tables, rows, and views. */
    async deleteBase(baseId: string): Promise<Omit<EraseSummary, "bases" | "authoredRows">> {
      return store.transaction(async (ops) => {
        if (!(await read(ops, "bases", baseId))) throw new NotFoundError(`base "${baseId}"`);
        const { writes, summary } = await planDropBase(ops, baseId);
        await apply(ops, writes);
        return { tables: summary.tables, rows: summary.rows, views: summary.views };
      });
    },
    /**
     * Make a field required or optional. Making it required fails when rows have no value for it:
     * the report lists them and nothing changes. A dry run returns the same report and writes nothing.
     */
    async setRequired(tableId: string, ref: string, required: boolean, opts: { dryRun?: boolean } = {}): Promise<MigrationReport> {
      return store.transaction(async (ops) => {
        const table = await loadTable(ops, tableId);
        const field = findField(table, ref);
        const rows = await all<RowDoc>(ops, "rows", { tableId }, "createdAt");
        const out = report(field, field.type, rows.map((r) => ({ id: r.id, value: r.data.values[field.id] })));
        for (const { id, data } of rows) {
          const value = data.values[field.id];
          if (required && isEmpty(value)) out.failures.push({ rowId: id, value: value ?? null, reason: "has no value" });
        }
        out.converted = out.total - out.failures.length;
        if (opts.dryRun) return out;
        if (out.failures.length > 0) throw new MigrationError(out);
        if (field.required !== required) await write(ops, "tables", tableId, changed(table, table.fields.map((f) => (f === field ? { ...f, required } : f))));
        return { ...out, applied: true };
      });
    },

    /** Replace the options of a select field. Rows that use a removed option abort the change, or lose that value. */
    async setOptions(tableId: string, ref: string, optionList: string[], opts: { onInUse?: "abort" | "clear" } = {}): Promise<MigrationReport> {
      return store.transaction(async (ops) => {
        const table = await loadTable(ops, tableId);
        const from = findField(table, ref);
        if (from.type !== "single_select" && from.type !== "multi_select") throw new ValidationError([{ field: from.name, code: "type", message: "is not a select field" }]);
        const to = { ...from, options: optionList };
        const issues: Issue[] = [];
        checkFields([to], [], issues);
        if (issues.length > 0) throw new ValidationError(issues);
        const rows = await all<RowDoc>(ops, "rows", { tableId }, "createdAt");
        const out = report(from, from.type, rows.map((r) => ({ id: r.id, value: r.data.values[from.id] })));
        const next = new Map<string, Json>();
        for (const { id, data } of rows) {
          const value = data.values[from.id];
          if (isEmpty(value)) continue;
          const kept = Array.isArray(value) ? (value as string[]).filter((o) => optionList.includes(o)) : optionList.includes(value as string) ? value : null;
          if (JSON.stringify(kept) === JSON.stringify(value)) out.converted += 1;
          else {
            out.failures.push({ rowId: id, value: value as Json, reason: "uses a removed option" });
            next.set(id, kept as Json);
          }
        }
        out.droppedOptions = (from.options ?? []).filter((o) => !optionList.includes(o));
        if (out.failures.length > 0 && opts.onInUse !== "clear") throw new MigrationError(out);
        if (from.required && [...next.values()].some(isEmpty)) throw new ValidationError([requiredNoClear(from)]);
        const rewrites = await planRewrite(ops, tableId, (doc, id) => (next.has(id) ? { ...doc.values, [from.id]: next.get(id) as Json } : null), rows);
        await apply(ops, [...rewrites, ["tables", tableId, changed(table, table.fields.map((f) => (f === from ? to : f)))]]);
        return { ...out, applied: true };
      });
    },
  };
}

export type Tables = ReturnType<typeof createTables>;
