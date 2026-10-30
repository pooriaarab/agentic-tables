// A typed client for the Worker HTTP API. It uses only `fetch`, so it runs in browsers, Workers and Node 22.
// Keep this file free of runtime imports: types only, so no Node or store code reaches a browser bundle.
import type { Role, SubjectKind } from "agentic-identity";
import type { Field, FieldInput, Issue, PrincipalKind, Row, Table, Values } from "./model.js";
import type { MigrationReport } from "./migrate.js";
import type { Filter, Sort } from "./query.js";
import type { AddFieldInput, Base, ChangeTypeOptions, EraseSummary, OwnerExport, RowPage, View, ViewInput, ViewRun } from "./tables.js";

export type { Issue, Field, FieldInput, Row, Table, Values, MigrationReport, Filter, Sort, AddFieldInput, Base, ChangeTypeOptions, EraseSummary, OwnerExport, RowPage, View, ViewInput, ViewRun, Role, SubjectKind };

const PREFIX = "/api/v1/tables";

/** A call the API refused, or one that got no usable answer. */
export class TablesClientError extends Error {
  constructor(
    /** The API error code, such as `NOT_FOUND`. `NETWORK` and `BAD_RESPONSE` come from the client. */
    readonly code: string,
    message: string,
    /** The HTTP status, or 0 when no answer came. */
    readonly status: number,
    /** Field issues of a `VALIDATION_FAILED` answer. */
    readonly issues?: Issue[],
    /** The migration report of a `MIGRATION_ABORTED` answer. */
    readonly report?: MigrationReport,
    /** The error that `fetch` threw, for a `NETWORK` failure. */
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "TablesClientError";
  }
}

/**
 * The caller, as headers (`x-principal-*`). The Worker ignores them: it needs `token`. Only the Node server
 * (`agentic-tables/node`, with `unsafeNoAuth`) reads these headers, and nothing proves them, so use them locally only.
 */
export interface ClientPrincipal {
  id: string;
  kind: PrincipalKind;
  /** Who the caller acts for, root first, as `human:ada`. An agent of a person needs it. */
  chain?: string;
  /** What the caller may do, as `table:read,base:read`. */
  scopes?: string;
}

export interface ClientOptions {
  /** The Worker origin, such as `https://tables.example.com`. A trailing `/api/v1/tables` is accepted. */
  baseUrl: string;
  /** Sent as `Authorization: Bearer <token>`. The Worker checks it with `agentic-identity`: no token, or a bad one, gets 401. */
  token?: string;
  /** The caller, as principal headers. For the Node server in unsafe mode only. */
  principal?: ClientPrincipal;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/** Every call takes this last. Abort it to cancel the request. */
export interface CallOptions {
  signal?: AbortSignal;
}

export interface QueryOptions extends CallOptions {
  filter?: Filter;
  sort?: Sort;
  limit?: number;
  cursor?: string;
}

export interface PageOptions extends CallOptions {
  limit?: number;
  cursor?: string;
}

export interface Subject {
  kind: SubjectKind;
  id: string;
}

export interface Membership {
  resourceId: string;
  subjectKind: SubjectKind;
  subjectId: string;
  role: Role;
}

/** One page of the roles on a base or a table, in id order. */
export interface MemberPage {
  grants: Membership[];
  nextCursor?: string;
}

export interface InviteInput {
  /** Not `owner`: only a share makes an owner. */
  role: Exclude<Role, "owner">;
  /** The person to invite. Give this or `handle`. */
  email?: string;
  /** The agent to invite. Give this or `email`. */
  handle?: string;
  /** How long the invite lives, in milliseconds. */
  expiresInMs?: number;
}

/** An invite that was made. It never holds the email. */
export interface Invited {
  id: string;
  resourceId: string;
  role: Exclude<Role, "owner">;
  for: "email" | "handle";
}

export interface LinkInput {
  /** Not `owner`: only a share makes an owner. */
  role: Exclude<Role, "owner">;
  /** Only a signed-in visitor may use the link. */
  signedInOnly?: boolean;
  /** How long the link lives, in milliseconds. */
  expiresInMs?: number;
}

/** A share link. The token shows once, when the link is made, and never in a list. */
export interface ShareLink {
  id: string;
  role: Exclude<Role, "owner">;
  signedInOnly: boolean;
  expiresAt?: number;
  revokedAt?: number;
}

/** The answer of a link create. Keep the token: it cannot be read again. */
export interface CreatedLink {
  id: string;
  token: string;
  resourceId: string;
  role: Exclude<Role, "owner">;
}

/** The share links of a base or a table, live ones first, up to 200. `truncated` says there are more. `skipped` counts damaged records left out. */
export interface LinkList {
  items: ShareLink[];
  truncated?: true;
  skipped?: number;
}

/** The answer of an unshare. */
export type Unshared = Omit<Membership, "role">;

export function createClient(options: ClientOptions) {
  const doFetch = options.fetch ?? globalThis.fetch?.bind(globalThis);
  if (typeof doFetch !== "function") throw new TypeError("no fetch available: pass options.fetch");
  const trimmed = options.baseUrl.replace(/\/+$/, "");
  const root = trimmed.endsWith(PREFIX) ? trimmed : trimmed + PREFIX;
  const auth: Record<string, string> = {};
  if (options.token) auth.authorization = `Bearer ${options.token}`;
  const p = options.principal;
  if (p) {
    auth["x-principal-id"] = p.id;
    auth["x-principal-kind"] = p.kind;
    if (p.chain) auth["x-principal-chain"] = p.chain;
    if (p.scopes !== undefined) auth["x-principal-scopes"] = p.scopes;
  }

  /** One request, no retry: a repeat of a write could write twice. */
  async function call<T>(method: string, path: string, opts: { body?: unknown; query?: Record<string, string | undefined>; signal?: AbortSignal } = {}): Promise<T> {
    const search = Object.entries(opts.query ?? {}).filter((e): e is [string, string] => e[1] !== undefined);
    const url = root + path + (search.length ? `?${new URLSearchParams(search)}` : "");
    const headers: Record<string, string> = { ...auth, accept: "application/json" };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    let response: Response;
    try {
      response = await doFetch(url, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), signal: opts.signal });
    } catch (error) {
      if (opts.signal?.aborted) throw error;
      throw new TablesClientError("NETWORK", "the request did not reach the API", 0, undefined, undefined, error);
    }
    let body: any;
    try {
      body = await response.json();
    } catch (error) {
      if (opts.signal?.aborted) throw error;
      throw new TablesClientError("BAD_RESPONSE", "the API answer is not JSON", response.status);
    }
    if (!response.ok) {
      const e = body?.error;
      throw new TablesClientError(typeof e?.code === "string" ? e.code : "BAD_RESPONSE", typeof e?.message === "string" ? e.message : `the API answered ${response.status}`, response.status, e?.issues, e?.report);
    }
    return body as T;
  }

  const id = encodeURIComponent;
  const at = (kind: "bases" | "tables", resourceId: string, rest: string) => `/${kind}/${id(resourceId)}${rest}`;
  const members = (kind: "bases" | "tables", resourceId: string, who: Subject) => `/${kind}/${id(resourceId)}/members/${id(who.kind)}/${id(who.id)}`;

  return {
    createBase: (name: string, o: CallOptions = {}) => call<Base>("POST", "/bases", { body: { name }, signal: o.signal }),
    listBases: async (o: CallOptions = {}) => (await call<{ items: Base[] }>("GET", "/bases", { signal: o.signal })).items,
    exportMyData: (o: CallOptions = {}) => call<OwnerExport>("GET", "/me/export", { signal: o.signal }),
    eraseMyData: (o: CallOptions = {}) => call<EraseSummary>("DELETE", "/me/data", { signal: o.signal }),
    claimBase: (baseId: string, o: CallOptions = {}) => call<{ baseId: string; owner: { id: string; kind: PrincipalKind } }>("POST", `/bases/${id(baseId)}/claim`, { signal: o.signal }),
    deleteBase: (baseId: string, o: CallOptions = {}) => call<Omit<EraseSummary, "bases" | "authoredRows">>("DELETE", `/bases/${id(baseId)}`, { signal: o.signal }),

    createTable: (baseId: string, name: string, fields: FieldInput[] = [], o: CallOptions = {}) =>
      call<Table>("POST", `/bases/${id(baseId)}/tables`, { body: { name, fields }, signal: o.signal }),
    listTables: async (baseId: string, o: CallOptions = {}) => (await call<{ items: Table[] }>("GET", `/bases/${id(baseId)}/tables`, { signal: o.signal })).items,
    getTable: (tableId: string, o: CallOptions = {}) => call<Table>("GET", `/tables/${id(tableId)}`, { signal: o.signal }),
    renameTable: (tableId: string, name: string, o: CallOptions = {}) => call<Table>("PATCH", `/tables/${id(tableId)}`, { body: { name }, signal: o.signal }),
    deleteTable: (tableId: string, o: CallOptions = {}) => call<{ rows: number; views: number }>("DELETE", `/tables/${id(tableId)}`, { signal: o.signal }),

    addField: (tableId: string, field: AddFieldInput, o: CallOptions = {}) => call<Table>("POST", `/tables/${id(tableId)}/fields`, { body: field, signal: o.signal }),
    renameField: (tableId: string, field: string, name: string, o: CallOptions = {}) =>
      call<Table>("PATCH", `/tables/${id(tableId)}/fields/${id(field)}`, { body: { name }, signal: o.signal }),
    deleteField: (tableId: string, field: string, o: CallOptions = {}) => call<Table>("DELETE", `/tables/${id(tableId)}/fields/${id(field)}`, { signal: o.signal }),
    setRequired: (tableId: string, field: string, required: boolean, o: CallOptions & { dryRun?: boolean } = {}) =>
      call<MigrationReport>("PUT", `/tables/${id(tableId)}/fields/${id(field)}/required`, { body: { required, dryRun: o.dryRun }, signal: o.signal }),
    changeFieldType: (tableId: string, field: string, change: ChangeTypeOptions, o: CallOptions = {}) =>
      call<MigrationReport>("POST", `/tables/${id(tableId)}/fields/${id(field)}/type`, { body: change, signal: o.signal }),

    insertRow: (tableId: string, values: Values, o: CallOptions = {}) => call<Row>("POST", `/tables/${id(tableId)}/rows`, { body: { values }, signal: o.signal }),
    /** All rows are written, or none. */
    insertRows: async (tableId: string, rows: Values[], o: CallOptions = {}) =>
      (await call<{ items: Row[] }>("POST", `/tables/${id(tableId)}/rows`, { body: { rows }, signal: o.signal })).items,
    queryRows: async (tableId: string, q: QueryOptions = {}) => {
      // The Worker reads `Field:desc`, so a colon in the field name would be cut.
      if (q.sort?.field.includes(":")) throw new TablesClientError("BAD_REQUEST", "a sort field cannot contain a colon", 0);
      return call<RowPage>("GET", `/tables/${id(tableId)}/rows`, {
        query: {
          filter: q.filter === undefined ? undefined : JSON.stringify(q.filter),
          sort: q.sort === undefined ? undefined : q.sort.direction === "desc" ? `${q.sort.field}:desc` : q.sort.field,
          limit: q.limit === undefined ? undefined : String(q.limit),
          cursor: q.cursor,
        },
        signal: q.signal,
      });
    },
    getRow: (rowId: string, o: CallOptions = {}) => call<Row>("GET", `/rows/${id(rowId)}`, { signal: o.signal }),
    updateRow: (rowId: string, values: Values, o: CallOptions = {}) => call<Row>("PATCH", `/rows/${id(rowId)}`, { body: { values }, signal: o.signal }),
    deleteRow: (rowId: string, o: CallOptions = {}) => call<{ deleted: string }>("DELETE", `/rows/${id(rowId)}`, { signal: o.signal }),

    createView: (tableId: string, view: ViewInput, o: CallOptions = {}) => call<View>("POST", `/tables/${id(tableId)}/views`, { body: view, signal: o.signal }),
    listViews: async (tableId: string, o: CallOptions = {}) => (await call<{ items: View[] }>("GET", `/tables/${id(tableId)}/views`, { signal: o.signal })).items,
    runView: (viewId: string, o: PageOptions = {}) =>
      call<ViewRun>("GET", `/views/${id(viewId)}/rows`, { query: { limit: o.limit === undefined ? undefined : String(o.limit), cursor: o.cursor }, signal: o.signal }),
    deleteView: (viewId: string, o: CallOptions = {}) => call<{ deleted: string }>("DELETE", `/views/${id(viewId)}`, { signal: o.signal }),

    shareBase: (baseId: string, who: Subject, role: Role, o: CallOptions = {}) => call<Membership>("PUT", members("bases", baseId, who), { body: { role }, signal: o.signal }),
    unshareBase: (baseId: string, who: Subject, o: CallOptions = {}) => call<Unshared>("DELETE", members("bases", baseId, who), { signal: o.signal }),
    shareTable: (tableId: string, who: Subject, role: Role, o: CallOptions = {}) => call<Membership>("PUT", members("tables", tableId, who), { body: { role }, signal: o.signal }),
    unshareTable: (tableId: string, who: Subject, o: CallOptions = {}) => call<Unshared>("DELETE", members("tables", tableId, who), { signal: o.signal }),
    /** Who holds a role on a base, in id order. Needs the owner role. Page on with `nextCursor`. */
    listBaseMembers: (baseId: string, o: PageOptions = {}) => call<MemberPage>("GET", at("bases", baseId, "/members"), { query: { limit: o.limit === undefined ? undefined : String(o.limit), cursor: o.cursor }, signal: o.signal }),
    /** The roles given on one table. A role on its base also applies, and does not show here. Needs the owner role. */
    listTableMembers: (tableId: string, o: PageOptions = {}) => call<MemberPage>("GET", at("tables", tableId, "/members"), { query: { limit: o.limit === undefined ? undefined : String(o.limit), cursor: o.cursor }, signal: o.signal }),
    /** Invite a person by email or an agent by handle. The answer holds the invite id, never the email. Needs the owner role. */
    inviteToBase: (baseId: string, input: InviteInput, o: CallOptions = {}) => call<Invited>("POST", at("bases", baseId, "/invites"), { body: input, signal: o.signal }),
    inviteToTable: (tableId: string, input: InviteInput, o: CallOptions = {}) => call<Invited>("POST", at("tables", tableId, "/invites"), { body: input, signal: o.signal }),
    /** Make a share link. The token comes back once and is never stored. Needs the owner role. */
    createBaseLink: (baseId: string, input: LinkInput, o: CallOptions = {}) => call<CreatedLink>("POST", at("bases", baseId, "/links"), { body: input, signal: o.signal }),
    createTableLink: (tableId: string, input: LinkInput, o: CallOptions = {}) => call<CreatedLink>("POST", at("tables", tableId, "/links"), { body: input, signal: o.signal }),
    /** The share links, without their tokens. Needs the owner role. */
    listBaseLinks: (baseId: string, o: CallOptions = {}) => call<LinkList>("GET", at("bases", baseId, "/links"), { signal: o.signal }),
    listTableLinks: (tableId: string, o: CallOptions = {}) => call<LinkList>("GET", at("tables", tableId, "/links"), { signal: o.signal }),
    revokeBaseLink: (baseId: string, linkId: string, o: CallOptions = {}) => call<{ id: string; resourceId: string }>("DELETE", at("bases", baseId, `/links/${id(linkId)}`), { signal: o.signal }),
    revokeTableLink: (tableId: string, linkId: string, o: CallOptions = {}) => call<{ id: string; resourceId: string }>("DELETE", at("tables", tableId, `/links/${id(linkId)}`), { signal: o.signal }),
  };
}

export type TablesClient = ReturnType<typeof createClient>;
