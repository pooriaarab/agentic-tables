// The Store port, copied from agentic-identity so this package builds alone.
// Keep the shape identical: equality filters, one orderBy, limit, cursor,
// transactions. Swap in the real port when agentic-identity is on npm.
export type Region = "eu" | "us" | "any";

export interface AdapterOptions {
  region?: Region;
}

export type Scalar = string | number | boolean | null;
export type Json = Scalar | Json[] | { [key: string]: Json };
export type Doc = { [key: string]: Json };

export interface Entry<T extends Doc = Doc> {
  id: string;
  data: T;
}

export interface Query {
  /** Top-level fields that must equal the value. All must match. */
  where?: Record<string, Scalar>;
  /** Sort by one field. A doc without the field (or with null) is left out. Ties sort by id. */
  orderBy?: { field: string; direction?: "asc" | "desc" };
  /** 1 or more. Defaults to `DEFAULT_LIMIT`. */
  limit?: number;
  /** The `nextCursor` of the previous page. Use it with the same query. */
  cursor?: string;
}

export interface Page<T extends Doc = Doc> {
  items: Entry<T>[];
  /** Set only when more items exist. */
  nextCursor?: string;
}

export const DEFAULT_LIMIT = 100;

export interface StoreOps {
  get<T extends Doc = Doc>(collection: string, id: string): Promise<T | null>;
  /** Replaces the whole doc. Docs must be plain JSON. */
  put<T extends Doc = Doc>(collection: string, id: string, doc: T): Promise<void>;
  /** Deleting a missing doc is not an error. */
  delete(collection: string, id: string): Promise<void>;
  query<T extends Doc = Doc>(collection: string, query?: Query): Promise<Page<T>>;
}

export interface Store extends StoreOps {
  readonly region: Region;
  /** All writes in `fn` apply together, or none do when `fn` throws. `fn` may run more than once. */
  transaction<R>(fn: (tx: StoreOps) => Promise<R>): Promise<R>;
}

export function assertCollection(name: string): void {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) throw new Error(`invalid collection name "${name}"`);
}

export function assertId(id: string): void {
  if (id.length === 0 || id.length > 256 || id.includes("/")) throw new Error(`invalid id "${id}"`);
}

export type Collections = Map<string, Map<string, Doc>>;

export const encode = (value: unknown): string =>
  btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const decode = (text: string): unknown =>
  JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))));

const compare = (a: Json, b: Json): number =>
  typeof a !== typeof b ? (typeof a < typeof b ? -1 : 1) : (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0;

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function storeOps(tables: Collections): StoreOps {
  return {
    async get<T extends Doc>(collection: string, id: string) {
      assertCollection(collection);
      assertId(id);
      const doc = tables.get(collection)?.get(id);
      return doc ? copy(doc) as T : null;
    },
    async put(collection, id, doc) {
      assertCollection(collection);
      assertId(id);
      if (!tables.has(collection)) tables.set(collection, new Map());
      tables.get(collection)!.set(id, copy(doc) as Doc);
    },
    async delete(collection, id) {
      assertCollection(collection);
      assertId(id);
      tables.get(collection)?.delete(id);
    },
    async query<T extends Doc>(collection: string, query: Query = {}): Promise<Page<T>> {
      assertCollection(collection);
      const limit = query.limit ?? DEFAULT_LIMIT;
      if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be an integer of 1 or more");
      const sign = query.orderBy?.direction === "desc" ? -1 : 1;
      const field = query.orderBy?.field;
      const order = (x: { v: Json; id: string }, y: { v: Json; id: string }) => sign * (compare(x.v, y.v) || compare(x.id, y.id));
      let rows = [...(tables.get(collection) ?? [])]
        .filter(([, doc]) => Object.entries(query.where ?? {}).every(([k, v]) => k in doc && doc[k] === v))
        .map(([id, doc]) => ({ id, doc, v: (field === undefined ? id : doc[field]) as Json }))
        .filter((row) => row.v !== undefined && row.v !== null)
        .sort(order);
      if (query.cursor !== undefined) {
        let after: { v: Json; id: string };
        try {
          const [v, id] = decode(query.cursor) as [Json, string];
          if (typeof id !== "string") throw new Error();
          after = { v, id };
        } catch {
          throw new Error("invalid cursor");
        }
        rows = rows.filter((row) => order(row, after) > 0);
      }
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        items: page.map((row) => ({ id: row.id, data: copy(row.doc) as T })),
        ...(rows.length > limit && last ? { nextCursor: encode([last.v, last.id]) } : {}),
      };
    },
  };
}

export function createMemoryStore(options: AdapterOptions = {}): Store {
  let tables: Collections = new Map();
  let lock: Promise<unknown> = Promise.resolve();
  // One operation at a time, so a transaction sees no other writer.
  const exclusive = <R>(fn: () => Promise<R>): Promise<R> => {
    const run = lock.then(fn, fn);
    lock = run.catch(() => undefined);
    return run;
  };
  return {
    region: options.region ?? "eu",
    get: (c, id) => exclusive(() => storeOps(tables).get(c, id)),
    put: (c, id, doc) => exclusive(() => storeOps(tables).put(c, id, doc)),
    delete: (c, id) => exclusive(() => storeOps(tables).delete(c, id)),
    query: (c, q) => exclusive(() => storeOps(tables).query(c, q)),
    transaction: (fn) =>
      exclusive(async () => {
        const draft: Collections = new Map([...tables].map(([name, docs]) => [name, new Map(docs)]));
        const result = await fn(storeOps(draft));
        tables = draft;
        return result;
      }),
  };
}
