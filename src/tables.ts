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
  type Issue,
  type Row,
  type Table,
  type Values,
} from "./model.js";
import type { Doc, Json, Page, Store, StoreOps } from "./store.js";

export interface Base {
  id: string;
  name: string;
  createdAt: string;
}

export interface TablesOptions {
  /** Clock in epoch milliseconds. Tests set it. */
  now?: () => number;
  /** Id source. Defaults to a random id with the prefix. */
  newId?: (prefix: string) => string;
}

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

async function all<T>(ops: StoreOps, collection: string, where: Record<string, string>, orderField: string): Promise<{ id: string; data: T }[]> {
  const out: { id: string; data: T }[] = [];
  let cursor: string | undefined;
  do {
    const page: Page = await ops.query(collection, { where, orderBy: { field: orderField }, limit: 500, cursor });
    out.push(...page.items.map((e) => ({ id: e.id, data: e.data as unknown as T })));
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return out;
}

const findField = (table: TableDoc, ref: string): Field => {
  const field = table.fields.find((f) => f.id === ref) ?? table.fields.find((f) => f.name === ref);
  if (!field) throw new NotFoundError(`field "${ref}"`);
  return field;
};

function checkFields(inputs: FieldInput[], taken: string[], issues: Issue[]): void {
  const names = taken.map((n) => n.toLowerCase());
  for (const input of inputs) {
    const at = (code: Issue["code"], message: string) => issues.push({ field: input.name, code, message });
    if (typeof input.name !== "string" || input.name.trim() === "") at("type", "needs a name");
    else if (names.includes(input.name.toLowerCase())) at("duplicate_field", "a field with this name exists");
    names.push(String(input.name).toLowerCase());
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

  const rewriteRows = async (ops: StoreOps, tableId: string, change: (doc: RowDoc, id: string) => Record<string, Json> | null): Promise<void> => {
    for (const { id, data } of await all<RowDoc>(ops, "rows", { tableId }, "createdAt")) {
      const values = change(data, id);
      if (values) await write(ops, "rows", id, { ...data, values });
    }
  };

  return {
    async createBase(name: string): Promise<Base> {
      if (name.trim() === "") throw new Error("base needs a name");
      const base = { id: newId("base"), name: name.trim(), createdAt: stamp() };
      await write(store, "bases", base.id, { name: base.name, createdAt: base.createdAt });
      return base;
    },
    async listBases(): Promise<Base[]> {
      return (await all<Omit<Base, "id">>(store, "bases", {}, "createdAt")).map((e) => ({ id: e.id, ...e.data }));
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
      const page = await store.query("rows", { where: { tableId }, orderBy: { field: "createdAt" }, ...listOptions });
      return { items: page.items.map((e) => rowView(table, e.id, e.data as unknown as RowDoc)), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
    },
    /** Delete a row and remove its id from every link that points at it. Cost grows with the rows of the tables that link here. */
    async deleteRow(rowId: string): Promise<void> {
      await store.transaction(async (ops) => {
        const row = await read<RowDoc>(ops, "rows", rowId);
        if (!row) throw new NotFoundError(`row "${rowId}"`);
        for (const { id: tableId, data: table } of await all<TableDoc>(ops, "tables", { baseId: row.baseId }, "createdAt")) {
          const links = table.fields.filter((f) => f.type === "link" && f.linkTable === row.tableId);
          if (links.length === 0) continue;
          await rewriteRows(ops, tableId, (doc) => {
            const hit = links.filter((f) => (doc.values[f.id] as string[] | undefined)?.includes(rowId));
            return hit.length === 0 ? null : { ...doc.values, ...Object.fromEntries(hit.map((f) => [f.id, (doc.values[f.id] as string[]).filter((id) => id !== rowId)])) };
          });
        }
        await ops.delete("rows", rowId);
      });
    },
  };
}

export type Tables = ReturnType<typeof createTables>;
