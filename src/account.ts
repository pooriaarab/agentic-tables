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
async function scan(tx: StoreOps, collection: Collection): Promise<Saved[]> {
  const out: Saved[] = [];
  let cursor: string | undefined;
  do {
    const page = await tx.query(collection, { limit: 100, ...(cursor === undefined ? {} : { cursor }) });
    out.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return out;
}

/** Read and validate before planning any writes. A damaged record may hide ownership or authorship. */
async function snapshot(tx: StoreOps, subject: AccountSubject) {
  const docs = {} as Record<Collection, Saved[]>;
  for (const c of collections) docs[c] = await scan(tx, c);
  for (const c of ["bases", "tables", "views", "rows"] as const) for (const r of docs[c]) {
    if (!json(r.data) || !time(r.data.createdAt)) bad();
    if ((c === "tables" || c === "rows") && !time(r.data.updatedAt)) bad();
  }
  const resources = new Map(docs.resources.map((d) => [d.id, d.data]));
  const bases = new Map(docs.bases.map((d) => [d.id, d.data]));
  const tables = new Map(docs.tables.map((d) => [d.id, d.data]));
  const ours = new Set([...bases.keys(), ...tables.keys()]);
  for (const { id, data } of docs.resources) if (data.type === "base" || data.type === "table") {
    if (!ours.has(id)) bad();
  }
  const paths = new Map<string, string[]>();
  for (const id of ours) {
    const path: string[] = [];
    let cur: string | null = id;
    while (cur !== null) {
      if (path.includes(cur) || path.length >= 16) bad();
      const r = resources.get(cur);
      if (!r || !text(r.type) || (r.parentId != null && !text(r.parentId))) bad();
      path.push(cur);
      cur = r.parentId == null ? null : r.parentId as string;
    }
    paths.set(id, path);
  }
  const relevant = new Set([...paths.values()].flat());
  for (const { id, data: g } of docs.grants) {
    if (!relevant.has(String(g.resourceId))) {
      if (g.subjectId === subject.id && (!text(g.resourceId) || !resources.has(g.resourceId))) bad();
      continue;
    }
    if (!text(g.subjectId) || !(SUBJECT_KINDS as readonly unknown[]).includes(g.subjectKind) || !(ROLES as readonly unknown[]).includes(g.role) || id !== `${String(g.resourceId)}:${String(g.subjectKind)}:${g.subjectId}`) bad();
  }
  const owners = (id: string) => docs.grants.filter((g) => paths.get(id)!.includes(String(g.data.resourceId)) && g.data.role === "owner");
  const mine = (g: Saved) => g.data.subjectId === subject.id && g.data.subjectKind === subject.kind;
  const owned = new Set([...ours].filter((id) => owners(id).some(mine)));
  const sole = new Set([...owned].filter((id) => owners(id).every(mine)));
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
  // Unknown children could be another application's data. Never remove their parent.
  for (const { id, data: r } of docs.resources) if (r.parentId != null && ours.has(String(r.parentId)) && !ours.has(id)) bad();
  return { docs, ours, owned, sole, mine };
}
const record = ({ id, data }: Saved): Json => ({ ...data, id });
const empty = () => ({ bases: 0, tables: 0, views: 0, rows: 0, authored_rows: 0, grants: 0 });

/** Store-backed contributor for the identity account registry. Stop writes during export and erase. */
export const tablesAccount: TablesAccount = {
  id: "tables",
  async exportAccount(subject, deps) {
    return check(subject, deps).transaction(async (tx) => {
      const { docs, ours, owned, mine } = await snapshot(tx, subject);
      const tableOwned = (r: Saved) => owned.has(String(r.data.tableId));
      return {
        bases: docs.bases.filter((r) => owned.has(r.id)).map(record),
        tables: docs.tables.filter((r) => owned.has(r.id)).map(record),
        views: docs.views.filter(tableOwned).map(record),
        rows: docs.rows.filter(tableOwned).map(record),
        authored_rows: docs.rows.filter((r) => !tableOwned(r) && (matches(r.data.createdBy, subject) || matches(r.data.updatedBy, subject))).map(record),
        grants: docs.grants.filter((g) => ours.has(String(g.data.resourceId)) && (mine(g) || owned.has(String(g.data.resourceId)))).map(record),
      };
    });
  },
  async eraseAccount(subject, deps) {
    return check(subject, deps).transaction(async (tx) => {
      const { docs, ours, sole, mine } = await snapshot(tx, subject);
      const total = empty();
      const gone = new Set(sole);
      // As in deleteTable, refuse links from a table that survives the erase.
      for (const t of docs.tables) if (!gone.has(t.id)) for (const f of t.data.fields as Doc[]) {
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
        if (gone.has(rid) || (c === "grants" && ours.has(rid) && mine(r))) {
          writes.push({ c, id: r.id }); if (c === "grants") total.grants++;
        }
      }
      // All reads have finished. The Store commits the entire erase or none of it.
      for (const w of writes) if (w.data) await tx.put(w.c, w.id, w.data); else await tx.delete(w.c, w.id);
      return total;
    });
  },
};
