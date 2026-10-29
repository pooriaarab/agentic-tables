import { PRINCIPAL_KINDS, resolveChain, type Principal, type PrincipalContext } from "agentic-identity";
import { TablesError, type PrincipalKind } from "./model.js";

const fail = (detail: string) => new TablesError("UNAUTHENTICATED", detail);

function parseStep(text: string): { kind: PrincipalKind; id: string } {
  const at = text.indexOf(":");
  const kind = text.slice(0, at) as PrincipalKind;
  if (at < 1 || at === text.length - 1 || !PRINCIPAL_KINDS.includes(kind)) throw fail(`"${text.slice(0, 40)}" must look like kind:id with kind one of ${PRINCIPAL_KINDS.join(", ")}`);
  return { kind, id: text.slice(at + 1) };
}

/**
 * The caller from request headers. Nothing proves these headers, so this stands in for a real `Auth` until
 * sign-in lands, and the Worker must not face the public internet. The chain is checked by `resolveChain`
 * from agentic-identity: the parent kinds, the depth, and the way scopes narrow.
 *
 *   x-principal-id, x-principal-kind   who acts (the leaf)
 *   x-principal-chain                  who it acts for, root first, as "kind:id,kind:id". Required for an agent of a person.
 *   x-principal-scopes                 what the leaf may do, as "table:read,base:read". Defaults to everything.
 */
export async function callerFromHeaders(get: (name: string) => string | undefined): Promise<PrincipalContext> {
  const id = get("x-principal-id") ?? "";
  const kind = get("x-principal-kind") as PrincipalKind;
  if (id === "" || !PRINCIPAL_KINDS.includes(kind)) throw fail(`send x-principal-id and x-principal-kind (one of ${PRINCIPAL_KINDS.join(", ")})`);
  const ancestors = (get("x-principal-chain") ?? "").split(",").filter((s) => s !== "").map(parseStep);
  const everything = ["*:admin"];
  const scopes = get("x-principal-scopes")?.split(",").map((s) => s.trim()) ?? everything;
  const steps = [...ancestors, { kind, id }];
  const principals = new Map<string, Principal>(
    steps.map((step, i) => [step.id, { id: step.id, kind: step.kind, ...(i > 0 ? { parentId: steps[i - 1]!.id } : {}), scopes: i === steps.length - 1 ? scopes : everything }]),
  );
  const resolved = await resolveChain(id, (key) => principals.get(key), { now: Date.now() });
  if (!resolved.ok || principals.size !== steps.length) throw fail("the principal chain is not valid");
  const { ok: _ok, ...context } = resolved;
  return context;
}
