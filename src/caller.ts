import { parsePrincipal, PRINCIPAL_KINDS, resolveChain, type Principal, type PrincipalContext } from "agentic-identity";
import { TablesError, type PrincipalKind } from "./model.js";

const fail = (detail: string) => new TablesError("UNAUTHENTICATED", detail);

function parseStep(text: string): { kind: PrincipalKind; id: string } {
  const at = text.indexOf(":");
  try {
    if (at < 1) throw new Error("no kind:id");
    return parsePrincipal({ kind: text.slice(0, at), id: text.slice(at + 1) });
  } catch {
    throw fail(`"${text.slice(0, 40)}" must look like kind:id with kind one of ${PRINCIPAL_KINDS.join(", ")} and an id of A-Z a-z 0-9 . _ -`);
  }
}

/** The input of a caller, as text. The Worker reads it from headers, and the CLI and MCP server read it from the environment. */
export interface CallerInput {
  id?: string;
  kind?: string;
  /** Who the caller acts for, root first, as "kind:id,kind:id". Required for an agent of a person. */
  chain?: string;
  /** What the caller may do, as "table:read,base:read". Defaults to everything. */
  scopes?: string;
}

/**
 * Build the caller. Nothing proves the input, so this stands in for a real `Auth` until sign-in lands. The chain is
 * checked by `resolveChain` from agentic-identity: the parent kinds, the depth, and the way scopes narrow.
 */
export async function resolveCaller(input: CallerInput): Promise<PrincipalContext> {
  const id = input.id ?? "";
  let kind: PrincipalKind;
  try {
    kind = parsePrincipal({ kind: input.kind, id }).kind;
  } catch {
    throw fail(`name the principal as an id of A-Z a-z 0-9 . _ - and a kind (one of ${PRINCIPAL_KINDS.join(", ")})`);
  }
  const ancestors = (input.chain ?? "").split(",").filter((s) => s !== "").map(parseStep);
  const everything = ["*:admin"];
  const scopes = input.scopes?.split(",").map((s) => s.trim()) ?? everything;
  const steps = [...ancestors, { kind, id }];
  const principals = new Map<string, Principal>(
    steps.map((step, i) => [step.id, { id: step.id, kind: step.kind, ...(i > 0 ? { parentId: steps[i - 1]!.id } : {}), scopes: i === steps.length - 1 ? scopes : everything }]),
  );
  const resolved = await resolveChain(id, (key) => principals.get(key), { now: Date.now() });
  if (!resolved.ok || principals.size !== steps.length) throw fail("the principal chain is not valid");
  const { ok: _ok, ...context } = resolved;
  return context;
}

/**
 * The caller from request headers. Nothing proves these headers, so the Worker must not face the public internet.
 *
 *   x-principal-id, x-principal-kind   who acts (the leaf)
 *   x-principal-chain                  who it acts for, root first. Required for an agent of a person.
 *   x-principal-scopes                 what the leaf may do. Defaults to everything.
 */
export const callerFromHeaders = (get: (name: string) => string | undefined): Promise<PrincipalContext> =>
  resolveCaller({ id: get("x-principal-id"), kind: get("x-principal-kind"), chain: get("x-principal-chain"), scopes: get("x-principal-scopes") });
