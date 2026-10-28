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
  /** The base this actor works in. Create the actor's own default base on first use. */
  baseId(): Promise<string>;
}

/**
 * Open the database. `AGENTIC_TABLES_DB` is the file path (default `./agentic-tables.json`).
 * `AGENTIC_TABLES_ACTOR` is who writes, as "kind:id".
 * `AGENTIC_TABLES_BASE` names the base to work in. Without it, each actor id gets its own default base,
 * so two actors on one file never share data by accident.
 */
export function openContext(env: Record<string, string | undefined>, defaultActor: string): Context {
  const tables = createTables(createFileStore(env.AGENTIC_TABLES_DB ?? "agentic-tables.json"));
  const actor = parseActor(env.AGENTIC_TABLES_ACTOR ?? defaultActor);
  const baseId = async (): Promise<string> => {
    const bases = await tables.listBases();
    if (env.AGENTIC_TABLES_BASE !== undefined) {
      if (!bases.some((b) => b.id === env.AGENTIC_TABLES_BASE)) throw new NotFoundError(`base "${env.AGENTIC_TABLES_BASE}"`);
      return env.AGENTIC_TABLES_BASE;
    }
    return bases.find((b) => b.ownerId === actor.id)?.id ?? (await tables.createBase("default", actor)).id;
  };
  return {
    tables,
    actor,
    baseId,
    async table(ref) {
      const all = await tables.listTables(await baseId());
      const found = all.find((t) => t.id === ref) ?? all.find((t) => t.name === ref);
      if (!found) throw new NotFoundError(`table "${ref}"`);
      return found;
    },
  };
}
