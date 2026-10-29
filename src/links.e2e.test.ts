// End to end: share links and members through the typed client (real Worker under `wrangler dev`), the real CLI, and the real MCP server.
// Ways it can fail:
//  - a list shows a token or a hash, or a link of another base or table
//  - a non-owner lists, makes, or revokes a link or an invite (FORBIDDEN), a stranger does (NOT_FOUND)
//  - a link of base A is revoked through base B or through a table
//  - a bad role (owner), a bad lifetime, or a bad flag is a crash and not an error with a code
//  - a revoked link still shows as live
// Needs a build first (`npm run build`).
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createClient, TablesClientError } from "./client.js";
import { seedD1 } from "./seed-d1.js";
import { startWorker, type RunningWorker } from "./wrangler-harness.js";

const PORT = 18796;
const persistTo = mkdtempSync(join(tmpdir(), "agentic-tables-links-"));
const dir = mkdtempSync(join(tmpdir(), "tables-links-"));
let worker: RunningWorker;
let seed: ReturnType<typeof seedD1>;

beforeAll(async () => {
  worker = await startWorker({ port: PORT, persistTo, vars: ["AGENTIC_TABLES_LOCAL_DEV:1", "AGENTIC_TABLES_REGION:eu"] });
  seed = seedD1(persistTo);
}, 240_000);
afterAll(async () => {
  await worker?.stop();
  rmSync(persistTo, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

const as = (id: string, kind = "human") => createClient({ baseUrl: `http://127.0.0.1:${PORT}`, token: seed.issue({ id, kind }) });
async function failure(promise: Promise<unknown>): Promise<TablesClientError> {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(TablesClientError);
  return error as TablesClientError;
}

describe("the client: members, invites, and links", () => {
  test("an owner lists members, invites, and makes, lists, and revokes links on a base and a table", async () => {
    const ada = as("ada");
    const base = await ada.createBase("Links");
    const other = await ada.createBase("Other");
    const table = await ada.createTable(base.id, "People", [{ name: "Name", type: "text" }]);
    await ada.shareBase(base.id, { kind: "human", id: "eve" }, "viewer");
    await ada.shareTable(table.id, { kind: "agent", id: "bot" }, "editor");
    expect((await ada.listBaseMembers(base.id)).grants.map((g) => `${g.subjectKind}:${g.subjectId}:${g.role}`)).toEqual(expect.arrayContaining(["human:ada:owner", "human:eve:viewer"]));
    expect((await ada.listTableMembers(table.id)).grants.map((g) => g.subjectId)).toContain("bot");
    const page = await ada.listBaseMembers(base.id, { limit: 1 });
    expect([page.grants.length, typeof page.nextCursor]).toEqual([1, "string"]);

    const invite = await ada.inviteToBase(base.id, { role: "viewer", email: "kim@example.com", expiresInMs: 60_000 });
    expect(invite).toMatchObject({ resourceId: base.id, role: "viewer", for: "email" });
    expect(JSON.stringify(invite)).not.toContain("example.com");
    expect((await ada.inviteToTable(table.id, { role: "commenter", handle: "robo" })).for).toBe("handle");

    const link = await ada.createBaseLink(base.id, { role: "viewer", signedInOnly: true, expiresInMs: 60_000 });
    const tableLink = await ada.createTableLink(table.id, { role: "editor" });
    await ada.createBaseLink(other.id, { role: "viewer" });
    expect(link.token.length).toBeGreaterThan(30);
    const listed = await ada.listBaseLinks(base.id);
    expect(listed.items).toEqual([{ id: link.id, role: "viewer", signedInOnly: true, expiresAt: expect.any(Number) }]);
    expect(JSON.stringify(listed)).not.toMatch(new RegExp(`${link.token}|tokenHash`));
    expect((await ada.listTableLinks(table.id)).items.map((l) => l.id)).toEqual([tableLink.id]);

    // A link of another resource is not found, even for the owner of both.
    expect((await failure(ada.revokeBaseLink(other.id, link.id))).code).toBe("NOT_FOUND");
    expect((await failure(ada.revokeTableLink(table.id, link.id))).code).toBe("NOT_FOUND");
    expect(await ada.revokeBaseLink(base.id, link.id)).toEqual({ id: link.id, resourceId: base.id });
    expect((await ada.listBaseLinks(base.id)).items[0]!.revokedAt).toEqual(expect.any(Number));
    expect((await ada.listBaseLinks(other.id)).items).toHaveLength(1);
  }, 60_000);

  test("a non-owner and a stranger are refused, and bad input has a code", async () => {
    const ada = as("ada");
    const base = await ada.createBase("Guarded");
    await ada.shareBase(base.id, { kind: "human", id: "eve" }, "editor");
    const link = await ada.createBaseLink(base.id, { role: "viewer" });
    const eve = as("eve");
    for (const run of [() => eve.listBaseMembers(base.id), () => eve.inviteToBase(base.id, { role: "viewer", handle: "bot" }), () => eve.listBaseLinks(base.id), () => eve.createBaseLink(base.id, { role: "viewer" }), () => eve.revokeBaseLink(base.id, link.id)]) {
      expect(await failure(run())).toMatchObject({ code: "FORBIDDEN", status: 403 });
    }
    const nobody = as("nobody");
    for (const run of [() => nobody.listBaseMembers(base.id), () => nobody.listBaseLinks(base.id), () => nobody.createBaseLink(base.id, { role: "viewer" })]) {
      expect(await failure(run())).toMatchObject({ code: "NOT_FOUND", status: 404 });
    }
    expect((await failure(ada.createBaseLink(base.id, { role: "owner" as never }))).code).toBe("BAD_REQUEST");
    expect((await failure(ada.createBaseLink(base.id, { role: "viewer", expiresInMs: 0 }))).code).toBe("BAD_REQUEST");
    expect((await failure(ada.createBaseLink(base.id, { role: "viewer", signedInOnly: "yes" as never }))).code).toBe("BAD_REQUEST");
    expect((await failure(ada.inviteToBase(base.id, { role: "owner" as never, handle: "bot" }))).code).toBe("BAD_REQUEST");
    expect((await failure(ada.inviteToBase(base.id, { role: "viewer" }))).code).toBe("BAD_REQUEST");
    expect((await failure(ada.revokeBaseLink(base.id, "nope"))).code).toBe("NOT_FOUND");
    // A credential without the admin scope is refused by name.
    const reader = createClient({ baseUrl: `http://127.0.0.1:${PORT}`, token: seed.issue({ id: "ada", kind: "human", scopes: ["base:read", "table:read"] }) });
    expect((await failure(reader.listBaseLinks(base.id))).code).toBe("FORBIDDEN");
  }, 60_000);
});

const bin = join(process.cwd(), "dist", "cli.js");
const env = (actor: string, extra: Record<string, string> = {}, baseId?: string) =>
  ({ ...process.env, AGENTIC_TABLES_DB: join(dir, "db.json"), AGENTIC_TABLES_ACTOR: actor, ...(baseId ? { AGENTIC_TABLES_BASE: baseId } : {}), ...extra }) as Record<string, string>;
let baseId = "";
const run = (args: string[], actor = "human:owen", extra: Record<string, string> = {}) => {
  const r = spawnSync("node", [bin, ...args], { env: env(actor, extra, baseId || undefined), encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const ok = (args: string[], actor?: string) => {
  const r = run(args, actor);
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  return JSON.parse(r.out) as any;
};
const codeOf = (r: { err: string }) => JSON.parse(r.err).error.code;

describe("the CLI: links", () => {
  beforeAll(() => {
    ok(["new", "Notes", "--field", "Body:text"]);
    baseId = ok(["bases"])[0].id;
  }, 60_000);

  test("makes, lists, and revokes links on a base and a table", () => {
    const made = ok(["link", "viewer", "--signed-in-only", "--expires-in-ms", "60000"]);
    expect(made).toMatchObject({ role: "viewer", resourceId: baseId });
    const tableLink = ok(["link", "editor", "--table", "Notes"]);
    const base = ok(["links"]);
    expect(base.items).toEqual([{ id: made.id, role: "viewer", signedInOnly: true, expiresAt: expect.any(Number) }]);
    expect(JSON.stringify(base)).not.toContain(made.token);
    expect(ok(["links", "--table", "Notes"]).items.map((l: any) => l.id)).toEqual([tableLink.id]);
    expect(codeOf(run(["revoke-link", tableLink.id]))).toBe("NOT_FOUND");
    expect(ok(["revoke-link", made.id])).toEqual({ id: made.id, resourceId: baseId });
    expect(ok(["links"]).items[0].revokedAt).toEqual(expect.any(Number));
  });

  test("a non-owner, a stranger, and a bad call get an exit code", () => {
    ok(["share", "eve", "editor", "--kind", "human"]);
    expect(codeOf(run(["links"], "human:eve"))).toBe("FORBIDDEN");
    expect(codeOf(run(["link", "viewer"], "human:eve"))).toBe("FORBIDDEN");
    expect(codeOf(run(["links"], "human:nobody"))).toBe("NOT_FOUND");
    expect(codeOf(run(["links"], "human:owen", { AGENTIC_TABLES_SCOPES: "base:read,table:read" }))).toBe("FORBIDDEN");
    expect(run(["link", "owner"]).code).toBe(2);
    expect(run(["link"]).code).toBe(2);
    expect(run(["link", "viewer", "--expires-in-ms", "soon"]).code).toBe(2);
    expect(run(["revoke-link"]).code).toBe(2);
    expect(codeOf(run(["link", "viewer", "--expires-in-ms", "-5"]))).toBe("BAD_REQUEST");
  });
});

describe("the MCP server: links", () => {
  const open = async (actor: string) => {
    const client = new Client({ name: "e2e-links", version: "0.0.0" });
    await client.connect(new StdioClientTransport({ command: "node", args: [bin, "mcp"], env: env(actor, {}, baseId) }));
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
      return { isError: r.isError === true, text: r.content[0]!.text, body: JSON.parse(r.content[0]!.text) };
    };
    return { client, call };
  };

  test("lists the tools, then makes, lists, and revokes a link", async () => {
    const owner = await open("human:owen");
    const editor = await open("human:eve");
    try {
      expect((await owner.client.listTools()).tools.map((t) => t.name)).toEqual(expect.arrayContaining(["list_links", "create_link", "revoke_link"]));
      const made = await owner.call("create_link", { role: "commenter", expiresInMs: 60_000, table: "Notes" });
      expect([made.isError, made.body.role]).toEqual([false, "commenter"]);
      const list = await owner.call("list_links", { table: "Notes" });
      expect(list.body.items.map((l: any) => l.id)).toContain(made.body.id);
      expect(list.text).not.toContain(made.body.token);
      expect((await owner.call("revoke_link", { link: made.body.id })).body.code).toBe("NOT_FOUND");
      expect((await owner.call("revoke_link", { link: made.body.id, table: "Notes" })).isError).toBe(false);
      expect((await owner.call("list_links", { table: "Notes" })).body.items.find((l: any) => l.id === made.body.id).revokedAt).toEqual(expect.any(Number));
      expect((await owner.client.callTool({ name: "create_link", arguments: { role: "owner" } })).isError).toBe(true);
      expect((await editor.call("list_links", {})).body.code).toBe("FORBIDDEN");
      expect((await editor.call("create_link", { role: "viewer" })).body.code).toBe("FORBIDDEN");
      expect((await editor.call("revoke_link", { link: "x" })).body.code).toBe("FORBIDDEN");
    } finally {
      await owner.client.close();
      await editor.client.close();
    }
  }, 60_000);
});
