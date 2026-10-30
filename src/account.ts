import { PRINCIPAL_KINDS, ROLES, SUBJECT_KINDS, type Doc, type Json, type Store, type StoreOps } from "agentic-identity";
import type { AccountPackage, AccountSubject } from "agentic-identity/account";
import { FIELD_TYPES, TablesError } from "./model.js";

export interface TablesAccountDeps { store: Store }
export type TablesCollection = "bases" | "tables" | "views" | "rows" | "authored_rows" | "grants";
export interface TablesAccount extends AccountPackage<TablesAccountDeps> {
  id: "tables";
  exportAccount(subject: AccountSubject, deps: TablesAccountDeps): Promise<Record<TablesCollection, Json[]>>;
  eraseAccount(subject: AccountSubject, deps: TablesAccountDeps): Promise<Record<TablesCollection, number>>;
}
/** Reserved author id. The original kind stays, including all agent kinds. */
export const ERASED_ACCOUNT_ID = "(erased)";
const collections = ["bases", "tables", "views", "rows", "resources", "grants", "invites", "links", "audit"] as const;
type Collection = typeof collections[number];
type Saved = { id: string; data: Doc };
function bad(): never { throw new TablesError("DAMAGED_ACCOUNT_DATA", "account data is damaged; repair it before account export or erase"); }
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const actor = (v: unknown): v is AccountSubject => {
  const a = v as AccountSubject | null;
  return text(a?.id) && (PRINCIPAL_KINDS as readonly unknown[]).includes(a?.kind);
};
function json(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  return Object.values(value).every((v) => json(v, depth + 1));
}
const time = (v: unknown) => text(v) && Number.isFinite(Date.parse(v));
const matches = (a: unknown, s: AccountSubject) => actor(a) && a.id === s.id && a.kind === s.kind;
function check(subject: AccountSubject, deps: TablesAccountDeps): Store {
  if (!actor(subject) || subject.id === ERASED_ACCOUNT_ID) throw new TablesError("BAD_REQUEST", "subject needs an id and a known kind");
  if (["get", "query", "put", "delete", "transaction"].some((k) => typeof (deps?.store as unknown as Record<string, unknown>)?.[k] !== "function")) throw new TablesError("BAD_REQUEST", "tablesAccount needs deps.store");
  return deps.store;
}
async function scan(tx: StoreOps, collection: Collection, where?: Record<string, string>): Promise<Saved[]> {
  const out: Saved[] = [];
  let cursor: string | undefined;
  do {
    const page = await tx.query(collection, { limit: 100, ...(where ? { where } : {}), ...(cursor === undefined ? {} : { cursor }) });
    out.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return out;
}

function validateGrant({ id, data: g }: Saved): string {
  if (!text(g.resourceId) || !text(g.subjectId) || !(SUBJECT_KINDS as readonly unknown[]).includes(g.subjectKind) || !(ROLES as readonly unknown[]).includes(g.role) || id !== `${String(g.resourceId)}:${String(g.subjectKind)}:${g.subjectId}`) bad();
  return g.resourceId;
}
async function resourcePath(id: string, read: (id: string) => Promise<Doc | null>): Promise<string[]> {
  const path: string[] = [];
  let current: string | null = id;
  while (current !== null) {
    if (path.includes(current) || path.length >= 16) bad();
    path.push(current);
    const resource: Doc | null = await read(current);
    if (!resource || !text(resource.type) || (resource.parentId != null && !text(resource.parentId))) bad();
    current = resource.parentId == null ? null : resource.parentId as string;
  }
  return path;
}
/** Follow only the subject's grants and their resource trees. Read before writing. */
async function snapshot(tx: StoreOps, subject: AccountSubject) {
  const docs = Object.fromEntries(collections.map((c) => [c, []])) as unknown as Record<Collection, Saved[]>;
  const seen = new Set<string>();
  const expanded = new Set<string>();
  const visit = async (id: string, descend = false): Promise<void> => {
    if (!seen.has(id)) {
      seen.add(id);
      const resource = await tx.get("resources", id);
      if (!resource) bad();
      docs.resources.push({ id, data: resource });
      if (resource.parentId != null) {
        if (!text(resource.parentId)) bad();
        await visit(resource.parentId);
      }
      docs.grants.push(...await scan(tx, "grants", { resourceId: id, role: "owner" }));
      if (resource.type === "base" || resource.type === "table") {
        const c = resource.type === "base" ? "bases" : "tables";
        const data = await tx.get(c, id);
        if (!data) bad();
        docs[c].push({ id, data });
      }
    }
    // Reading an ancestor or a former creator's base does not own its children.
    if (!descend || expanded.has(id)) return;
    expanded.add(id);
    const resource = docs.resources.find((r) => r.id === id)!.data;
    if (resource.type === "base") for (const table of await scan(tx, "tables", { baseId: id })) await visit(table.id, true);
    for (const child of await scan(tx, "resources", { parentId: id })) {
      if (child.data.type !== "table" || resource.type !== "base") bad();
      await visit(child.id, true);
    }
  };
  for (const g of await scan(tx, "grants", { subjectId: subject.id, subjectKind: subject.kind })) {
    const rid = validateGrant(g);
    const resource = await tx.get("resources", rid);
    // Other registry contributors own other resource types.
    if (!resource) bad();
    if (resource.type === "base" || resource.type === "table") {
      if (g.data.role === "owner") await visit(rid, true);
      else {
        // A viewer/editor owns its grant, not the other owner's row tree.
        await resourcePath(rid, (id) => tx.get("resources", id));
        docs.grants.push(g);
      }
    }
    else if (await tx.get("bases", rid) || await tx.get("tables", rid)) bad();
  }
  // A legacy base or a damaged/missing grant must not hide the subject's data.
  // A valid transfer still has other owner grants and is kept by the erase.
  for (const base of await scan(tx, "bases", { ownerId: subject.id })) {
    if (!(PRINCIPAL_KINDS as readonly unknown[]).includes(base.data.ownerKind)) bad();
    if (base.data.ownerKind === subject.kind) await visit(base.id);
  }
  const resources = new Map(docs.resources.map((d) => [d.id, d.data]));
  const bases = new Map(docs.bases.map((d) => [d.id, d.data]));
  const tables = new Map(docs.tables.map((d) => [d.id, d.data]));
  const ours = new Set([...bases.keys(), ...tables.keys()]);
  const paths = new Map<string, string[]>();
  for (const id of ours) paths.set(id, await resourcePath(id, async (key) => resources.get(key) ?? null));
  docs.grants = [...new Map(docs.grants.map((g) => [g.id, g])).values()];
  for (const grant of docs.grants) validateGrant(grant);
  const owners = (id: string) => docs.grants.filter((g) => paths.get(id)!.includes(String(g.data.resourceId)) && g.data.role === "owner");
  const mine = (g: Saved) => g.data.subjectId === subject.id && g.data.subjectKind === subject.kind;
  const owned = new Set([...ours].filter((id) => owners(id).some(mine)));
  for (const id of owned) docs.grants.push(...await scan(tx, "grants", { resourceId: id }));
  docs.grants = [...new Map(docs.grants.map((g) => [g.id, g])).values()];
  for (const grant of docs.grants) validateGrant(grant);
  const sole = new Set([...owned].filter((id) => owners(id).every(mine)));
  for (const table of docs.tables) if (owned.has(table.id)) for (const c of ["rows", "views"] as const) docs[c].push(...await scan(tx, c, { tableId: table.id }));
  for (const c of ["bases", "tables", "views", "rows"] as const) for (const r of docs[c]) {
    if (!json(r.data) || !time(r.data.createdAt)) bad();
    if ((c === "tables" || c === "rows") && !time(r.data.updatedAt)) bad();
  }
  for (const { id, data: b } of docs.bases) {
    if (!text(b.name) || !actor({ id: b.ownerId, kind: b.ownerKind }) || resources.get(id)?.type !== "base" || (owners(id).length === 0 && b.ownerId !== ERASED_ACCOUNT_ID)) bad();
    // A table can have another direct owner. Keep its whole base in that case.
    if (docs.tables.some((t) => t.data.baseId === id && !sole.has(t.id))) sole.delete(id);
  }
  for (const { id, data: t } of docs.tables) {
    if (!text(t.name)) bad();
    const fields = t.fields as Doc[];
    if (!Array.isArray(fields) || fields.some((f) => !f || !text(f.id) || !text(f.name) || !(FIELD_TYPES as readonly unknown[]).includes(f.type) || typeof f.required !== "boolean") || new Set(fields.map((f) => f.id)).size !== fields.length) bad();
    if (!text(t.baseId) || !bases.has(t.baseId) || !Array.isArray(t.fields) || resources.get(id)?.type !== "table" || resources.get(id)?.parentId !== t.baseId || owners(id).length === 0) bad();
  }
  for (const { data: r } of docs.rows) {
    const t = tables.get(String(r.tableId));
    if (!t || r.baseId !== t.baseId || !actor(r.createdBy) || !actor(r.updatedBy) || r.values === null || typeof r.values !== "object" || Array.isArray(r.values)) bad();
  }
  for (const { data: v } of docs.views) if (!tables.has(String(v.tableId))) bad();
  for (const id of sole) for (const c of ["invites", "links", "audit"] as const) docs[c].push(...await scan(tx, c, { resourceId: id }));
  const linkTables = new Map(docs.tables.map((t) => [t.id, t]));
  // A sole table in a retained container needs sibling link checks before deletion.
  for (const table of docs.tables) if (sole.has(table.id) && !owned.has(String(table.data.baseId))) {
    for (const sibling of await scan(tx, "tables", { baseId: String(table.data.baseId) })) linkTables.set(sibling.id, sibling);
  }
  return { docs, owned, sole, mine, linkTables: [...linkTables.values()] };
}
const record = ({ id, data }: Saved): Json => ({ ...data, id });
const empty = () => ({ bases: 0, tables: 0, views: 0, rows: 0, authored_rows: 0, grants: 0 });

// Authorship has no portable nested-field index. Scan outside transactions so unrelated
// documents never enter the D1 version checks. Recheck each candidate before a write.
async function authored(store: Store, subject: AccountSubject) {
  return (await scan(store, "rows")).filter((r) => matches(r.data.createdBy, subject) || matches(r.data.updatedBy, subject));
}
async function validateAuthored(tx: StoreOps, r: Saved) {
  if (!text(r.data.tableId) || !text(r.data.baseId) || !r.data.values || typeof r.data.values !== "object" || Array.isArray(r.data.values)) bad();
  const table = await tx.get("tables", r.data.tableId);
  if (!table || table.baseId !== r.data.baseId) bad();
  if (!json(r.data) || !time(r.data.createdAt) || !time(r.data.updatedAt) || !actor(r.data.createdBy) || !actor(r.data.updatedBy)) bad();
}
/** Store-backed contributor for the identity account registry. */
export const tablesAccount: TablesAccount = {
  id: "tables",
  async exportAccount(subject, deps) {
    const store = check(subject, deps);
    const candidates = await authored(store, subject);
    for (const row of candidates) await validateAuthored(store, row);
    const result = await store.transaction(async (tx) => {
      const { docs, owned, mine } = await snapshot(tx, subject);
      const tableOwned = (r: Saved) => owned.has(String(r.data.tableId));
      return {
        bases: docs.bases.filter((r) => owned.has(r.id)).map(record),
        tables: docs.tables.filter((r) => owned.has(r.id)).map(record),
        views: docs.views.filter(tableOwned).map(record),
        rows: docs.rows.filter(tableOwned).map(record),
        authored_rows: docs.rows.filter((r) => !tableOwned(r) && (matches(r.data.createdBy, subject) || matches(r.data.updatedBy, subject))).map(record),
        grants: docs.grants.filter((g) => mine(g) || owned.has(String(g.data.resourceId))).map(record),
      };
    });
    const included = new Set([...result.rows, ...result.authored_rows].map((r) => (r as Doc).id));
    result.authored_rows.push(...candidates.filter((r) => !included.has(r.id)).map(record));
    return result;
  },
  async eraseAccount(subject, deps) {
    const store = check(subject, deps);
    const candidates = await authored(store, subject);
    for (const row of candidates) await validateAuthored(store, row);
    const result = await store.transaction(async (tx) => {
      const { docs, sole, mine, linkTables } = await snapshot(tx, subject);
      const total = empty();
      const gone = new Set(sole);
      // As in deleteTable, refuse links from a table that survives the erase.
      for (const t of linkTables) if (!gone.has(t.id)) for (const f of (Array.isArray(t.data.fields) ? t.data.fields : bad()) as Doc[]) {
        if (!f) bad();
        if (f.type === "link" && gone.has(String(f.linkTable))) throw new TablesError("LINKED_TABLE", "remove links to a sole-owned table before account erase");
      }
      const writes: { c: Collection; id: string; data?: Doc }[] = [];
      for (const c of ["bases", "tables", "views", "rows"] as const) for (const r of docs[c]) {
        const remove = gone.has(c === "bases" || c === "tables" ? r.id : String(r.data.tableId));
        if (remove) { writes.push({ c, id: r.id }); total[c]++; continue; }
        const data = { ...r.data };
        let changed = false;
        if (c === "bases" && matches({ id: data.ownerId, kind: data.ownerKind }, subject)) { data.ownerId = ERASED_ACCOUNT_ID; changed = true; }
        if (c === "rows") for (const key of ["createdBy", "updatedBy"] as const) if (matches(data[key], subject)) {
          data[key] = { id: ERASED_ACCOUNT_ID, kind: subject.kind }; changed = true;
        }
        if (changed) { writes.push({ c, id: r.id, data }); if (c === "rows") total.authored_rows++; }
      }
      for (const c of ["resources", "grants", "invites", "links", "audit"] as const) for (const r of docs[c]) {
        const rid = c === "resources" ? r.id : String(r.data.resourceId);
        if (gone.has(rid) || (c === "grants" && mine(r))) {
          writes.push({ c, id: r.id }); if (c === "grants") total.grants++;
        }
      }
      // All reads have finished. The Store commits this resource cleanup or none of it.
      for (const w of writes) if (w.data) await tx.put(w.c, w.id, w.data); else await tx.delete(w.c, w.id);
      return total;
    });
    for (const candidate of candidates) result.authored_rows += await store.transaction(async (tx) => {
      const data = await tx.get("rows", candidate.id);
      if (!data || (!matches(data.createdBy, subject) && !matches(data.updatedBy, subject))) return 0;
      await validateAuthored(tx, { id: candidate.id, data });
      for (const key of ["createdBy", "updatedBy"] as const) if (matches(data[key], subject)) data[key] = { id: ERASED_ACCOUNT_ID, kind: subject.kind };
      await tx.put("rows", candidate.id, data);
      return 1;
    });
    return result;
  },
};
