import { NotFoundError, PRINCIPAL_KINDS, TablesError, type Actor, type PrincipalKind, type Table } from "./model.js";
import { createFileStore } from "./store-file.js";
import { createTables, type Tables } from "./tables.js";

/** Read "kind:id", for example "agent:claude". */
export function parseActor(spec: string): Actor {
  const at = spec.indexOf(":");
  const kind = spec.slice(0, at) as PrincipalKind;
  if (at < 1 || at === spec.length - 1 || !PRINCIPAL_KINDS.includes(kind)) {
    throw new TablesError("USAGE", `actor must look like "kind:id" with kind one of ${PRINCIPAL_KINDS.join(", ")}`);
  }
  return { kind, id: spec.slice(at + 1) };
}

export interface Context {
  tables: Tables;
  actor: Actor;
  /** Find a table in the default base by name or id. */
  table(ref: string): Promise<Table>;
  /** Create the default base on first use. */
  baseId(): Promise<string>;
}

/**
 * Open the database. `AGENTIC_TABLES_DB` is the file path (default `./agentic-tables.json`).
 * `AGENTIC_TABLES_ACTOR` is who writes, as "kind:id".
 */
export function openContext(env: Record<string, string | undefined>, defaultActor: string): Context {
  const tables = createTables(createFileStore(env.AGENTIC_TABLES_DB ?? "agentic-tables.json"));
  const baseId = async (): Promise<string> => (await tables.listBases())[0]?.id ?? (await tables.createBase("default")).id;
  return {
    tables,
    actor: parseActor(env.AGENTIC_TABLES_ACTOR ?? defaultActor),
    baseId,
    async table(ref) {
      const all = await tables.listTables(await baseId());
      const found = all.find((t) => t.id === ref) ?? all.find((t) => t.name === ref);
      if (!found) throw new NotFoundError(`table "${ref}"`);
      return found;
    },
  };
}
