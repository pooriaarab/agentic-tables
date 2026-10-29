// Test helper: put principals and credentials into the local D1 database of a `wrangler dev` run, as `issueCredential` would,
// so the suites can sign in to a real Worker. It is not part of the package.
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parsePrincipal } from "agentic-identity";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function databaseFile(persistTo: string): string {
  const dir = join(persistTo, "v3", "d1", "miniflare-D1DatabaseObject");
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".sqlite") || name === "metadata.sqlite") continue;
    const db = new DatabaseSync(join(dir, name));
    try {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'store_docs'").get()) return join(dir, name);
    } finally {
      db.close();
    }
  }
  throw new Error("the Worker has not made its table yet: send it one request first");
}

export interface Seeded {
  /** A principal and the token that signs in as it. */
  issue(input: { id: string; kind: string; chain?: { id: string; kind: string }[]; scopes?: string[]; expiresAt?: number }): string;
  /** Mark the credential revoked now. */
  revoke(token: string): void;
  /** Turn the `x-principal-*` headers of the suites into the same caller with a bearer token. A bad header gives a token that fails. */
  asBearer(headers: Record<string, string>): Record<string, string>;
}

export function seedD1(persistTo: string): Seeded {
  const file = databaseFile(persistTo);
  const put = (collection: string, id: string, doc: unknown) => {
    const db = new DatabaseSync(file);
    try {
      db.exec("PRAGMA busy_timeout = 10000");
      db.prepare("INSERT INTO store_docs (collection, id, body) VALUES (?, ?, ?) ON CONFLICT (collection, id) DO UPDATE SET body = excluded.body, version = version + 1").run(collection, id, JSON.stringify(doc));
    } finally {
      db.close();
    }
  };
  const everything = ["*:admin"];
  const issue: Seeded["issue"] = ({ id, kind, chain = [], scopes = everything, expiresAt }) => {
    const steps = [...chain, { id, kind }];
    steps.forEach((step, i) => put("principals", step.id, { id: step.id, kind: step.kind, ...(i > 0 ? { parentId: steps[i - 1]!.id } : {}), scopes: i === steps.length - 1 ? scopes : everything, ...(i === steps.length - 1 && expiresAt !== undefined ? { expiresAt } : {}) }));
    const token = `aid_${sha256(JSON.stringify(steps) + scopes.join())}`.slice(0, 44);
    put("credentials", sha256(token), { principalId: id, kind: "api_key" });
    return token;
  };
  const revoke: Seeded["revoke"] = (token) => {
    const db = new DatabaseSync(file);
    try {
      db.prepare("UPDATE store_docs SET body = json_set(body, '$.revokedAt', ?), version = version + 1 WHERE collection = 'credentials' AND id = ?").run(Date.now(), sha256(token));
    } finally {
      db.close();
    }
  };
  const asBearer: Seeded["asBearer"] = (headers) => {
    const rest = Object.fromEntries(Object.entries(headers).filter(([name]) => !name.startsWith("x-principal-")));
    try {
      const kind = parsePrincipal({ kind: headers["x-principal-kind"], id: headers["x-principal-id"] ?? "" }).kind;
      const chain = (headers["x-principal-chain"] ?? "").split(",").filter((s) => s !== "").map((text) => {
        const at = text.indexOf(":");
        return parsePrincipal({ kind: text.slice(0, at), id: text.slice(at + 1) });
      });
      const scopes = headers["x-principal-scopes"]?.split(",").map((s) => s.trim());
      return { ...rest, authorization: `Bearer ${issue({ id: headers["x-principal-id"]!, kind, chain, ...(scopes ? { scopes } : {}) })}` };
    } catch {
      return { ...rest, authorization: "Bearer aid_not_a_credential" };
    }
  };
  return { issue, revoke, asBearer };
}
