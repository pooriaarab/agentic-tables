import { createSharing, hasScope, parsePrincipal, PRINCIPAL_KINDS } from "agentic-identity";
import { resolveCaller } from "./caller.js";
import { createGuarded, type Guarded } from "./guarded.js";
import { NotFoundError, TablesError, type Actor, type Table } from "./model.js";
import { createFileStore } from "./store-file.js";
import { createTables } from "./tables.js";

/** Read "kind:id", for example "agent:claude". */
export function parseActor(spec: string): Actor {
  const at = spec.indexOf(":");
  try {
    if (at < 1) throw new Error("no kind:id");
    return parsePrincipal({ kind: spec.slice(0, at), id: spec.slice(at + 1) });
  } catch {
    throw new TablesError("USAGE", `actor must look like "kind:id" with kind one of ${PRINCIPAL_KINDS.join(", ")} and an id of A-Z a-z 0-9 . _ -`);
  }
}

export interface Context {
  /** Who acts, for the label on each row. */
  actor: Actor;
  /** The tables API for the actor. Every call checks the role of the actor, as the Worker does. */
  tables: Guarded;
  /** Find a table in the default base by name or id. */
  table(ref: string): Promise<Table>;
  /** The base this actor works in. Create the actor's own default base on first use. */
  baseId(): Promise<string>;
}

/**
 * Open the database. `AGENTIC_TABLES_DB` is the file path (default `./agentic-tables.json`).
 * `AGENTIC_TABLES_ACTOR` is who acts, as "kind:id". An agent of a person also needs `AGENTIC_TABLES_CHAIN`
 * (who it acts for, root first, as "kind:id,kind:id"). `AGENTIC_TABLES_SCOPES` narrows what the actor may do.
 * Nothing proves these values: the file belongs to the person who runs the process.
 * `AGENTIC_TABLES_BASE` names the base to work in. Without it, each actor (or the person it acts for) gets its own
 * default base, so two actors on one file never share data by accident.
 */
export async function openContext(env: Record<string, string | undefined>, defaultActor: string): Promise<Context> {
  const store = createFileStore(env.AGENTIC_TABLES_DB ?? "agentic-tables.json");
  const actor = parseActor(env.AGENTIC_TABLES_ACTOR ?? defaultActor);
  const principal = await resolveCaller({ id: actor.id, kind: actor.kind, chain: env.AGENTIC_TABLES_CHAIN, scopes: env.AGENTIC_TABLES_SCOPES });
  const tables = createGuarded(createTables(store), createSharing(store), store)(principal);
  const root = principal.chain[0]!;
  const baseId = async (): Promise<string> => {
    if (env.AGENTIC_TABLES_BASE !== undefined) {
      await tables.listTables(env.AGENTIC_TABLES_BASE);
      return env.AGENTIC_TABLES_BASE;
    }
    // Without base:read the list is empty, and a new base would be refused for a reason that does not show the cause.
    if (!hasScope(principal.scopes, "base:read")) throw new TablesError("FORBIDDEN", "this credential does not allow read on a base");
    const mine = (await tables.listBases()).find((b) => b.ownerId === root.id && b.ownerKind === root.kind);
    return mine?.id ?? (await tables.createBase("default")).id;
  };
  return {
    actor,
    tables,
    baseId,
    async table(ref) {
      const all = await tables.listTables(await baseId());
      const found = all.find((t) => t.id === ref) ?? all.find((t) => t.name === ref);
      if (!found) throw new NotFoundError(`table "${ref}"`);
      return found;
    },
  };
}
