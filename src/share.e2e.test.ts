// End to end: list access and make invites, through the real CLI and the real MCP server.
// Ways it can fail:
//  - a viewer or an editor lists shares or makes an invite (FORBIDDEN), a stranger does (NOT_FOUND)
//  - a credential without the admin scope does either
//  - an invite names both an email and a handle, or neither, or a bad role, email, handle, or lifetime
//  - an invite answer or a list carries an email address
//  - a revoked share still shows in the list
// Needs a build first (`npm run build`).
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const cli = join(process.cwd(), "dist", "cli.js");
const dir = mkdtempSync(join(tmpdir(), "tables-share-"));
const base = { ...process.env, AGENTIC_TABLES_DB: join(dir, "db.json") } as Record<string, string>;
let baseId = "";

const run = (args: string[], actor = "human:owen", extra: Record<string, string> = {}) => {
  const r = spawnSync("node", [cli, ...args], { env: { ...base, AGENTIC_TABLES_ACTOR: actor, ...(baseId ? { AGENTIC_TABLES_BASE: baseId } : {}), ...extra }, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const ok = (args: string[], actor?: string) => {
  const r = run(args, actor);
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  return JSON.parse(r.out) as any;
};
const code = (r: { err: string }) => JSON.parse(r.err).error.code;

beforeAll(() => {
  ok(["new", "Notes", "--field", "Body:text"]);
  baseId = ok(["bases"])[0].id;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("shares and invite in the CLI", () => {
  test("an owner lists the roles and sees a revoke", () => {
    ok(["share", "vera", "viewer", "--kind", "human"]);
    ok(["share", "bot", "editor", "--kind", "agent", "--table", "Notes"]);
    const onBase = ok(["shares"]).grants;
    expect(onBase.map((g: any) => [g.subjectKind, g.subjectId, g.role])).toEqual(expect.arrayContaining([["human", "owen", "owner"], ["human", "vera", "viewer"]]));
    expect(onBase.some((g: any) => g.subjectId === "bot")).toBe(false);
    expect(ok(["shares", "--table", "Notes"]).grants.map((g: any) => g.subjectId)).toContain("bot");
    expect(ok(["shares", "--limit", "1"]).nextCursor).toEqual(expect.any(String));
    ok(["unshare", "vera", "--kind", "human"]);
    expect(ok(["shares"]).grants.some((g: any) => g.subjectId === "vera")).toBe(false);
  });

  test("a non-owner cannot list, and a stranger finds nothing", () => {
    ok(["share", "eve", "editor", "--kind", "human"]);
    expect(code(run(["shares"], "human:eve"))).toBe("FORBIDDEN");
    expect(code(run(["invite", "viewer", "--handle", "bot"], "human:eve"))).toBe("FORBIDDEN");
    expect(code(run(["shares"], "human:nobody"))).toBe("NOT_FOUND");
    expect(code(run(["shares"], "human:owen", { AGENTIC_TABLES_SCOPES: "base:read,table:read" }))).toBe("FORBIDDEN");
    expect(code(run(["invite", "viewer", "--handle", "bot"], "human:owen", { AGENTIC_TABLES_SCOPES: "base:read,table:read" }))).toBe("FORBIDDEN");
  });

  test("an invite answers with an id and never the email", () => {
    const made = run(["invite", "viewer", "--email", "Sam@Example.com", "--expires-in-ms", "60000"]);
    expect(made.code).toBe(0);
    expect(made.out).not.toMatch(/example\.com/i);
    expect(JSON.parse(made.out)).toMatchObject({ resourceId: baseId, role: "viewer", for: "email", id: expect.any(String) });
    expect(ok(["invite", "editor", "--handle", "helper", "--table", "Notes"])).toMatchObject({ for: "handle", role: "editor" });
    expect(run(["shares"]).out).not.toMatch(/example\.com/i);
  });

  test("a bad invite is refused", () => {
    expect(run(["invite", "viewer"]).code).toBe(2);
    expect(run(["invite", "viewer", "--email", "a@b.co", "--handle", "bot"]).code).toBe(2);
    expect(run(["invite", "boss", "--handle", "bot"]).code).toBe(2);
    expect(run(["invite"]).code).toBe(2);
    expect(run(["invite", "viewer", "--handle", "bot", "--expires-in-ms", "soon"]).code).toBe(2);
    expect(code(run(["invite", "viewer", "--email", "not-an-email"]))).toBe("BAD_REQUEST");
    expect(code(run(["invite", "viewer", "--handle", "bad handle!"]))).toBe("BAD_REQUEST");
    expect(code(run(["invite", "viewer", "--handle", "bot", "--expires-in-ms", "-5"]))).toBe("BAD_REQUEST");
    expect(run(["invite", "owner", "--handle", "bot"]).code).toBe(2);
    for (const limit of ["x", "0", "100000"]) expect(run(["shares", "--limit", limit]).code).toBe(2);
  });
});

describe("list_shares and create_invite in the MCP server", () => {
  const open = async (actor: string) => {
    const client = new Client({ name: "e2e-share", version: "0.0.0" });
    await client.connect(new StdioClientTransport({ command: "node", args: [cli, "mcp"], env: { ...base, AGENTIC_TABLES_ACTOR: actor, AGENTIC_TABLES_BASE: baseId } }));
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
      return { isError: r.isError === true, text: r.content[0]!.text, body: JSON.parse(r.content[0]!.text) };
    };
    return { client, call };
  };

  test("an owner lists and invites, an editor is refused", async () => {
    const owner = await open("human:owen");
    const editor = await open("human:eve");
    try {
      expect((await owner.client.listTools()).tools.map((t) => t.name)).toEqual(expect.arrayContaining(["list_shares", "create_invite"]));
      const listed = await owner.call("list_shares", {});
      expect(listed.isError).toBe(false);
      expect(listed.body.grants.map((g: any) => g.subjectId)).toContain("eve");
      expect((await owner.call("list_shares", { table: "Notes" })).body.grants.map((g: any) => g.subjectId)).toContain("bot");
      const invite = await owner.call("create_invite", { role: "commenter", email: "kim@example.com" });
      expect(invite.isError).toBe(false);
      expect(invite.text).not.toContain("example.com");
      expect(invite.body).toMatchObject({ for: "email", role: "commenter" });
      expect((await owner.call("create_invite", { role: "viewer", handle: "bot", table: "Notes" })).body.for).toBe("handle");
      expect((await owner.client.callTool({ name: "create_invite", arguments: { role: "owner", handle: "bot" } })).isError).toBe(true);
      expect((await owner.client.callTool({ name: "list_shares", arguments: { limit: 0 } })).isError).toBe(true);
      expect((await owner.call("create_invite", { role: "viewer" })).body.code).toBe("BAD_REQUEST");
      expect((await owner.call("create_invite", { role: "viewer", email: "a@b.co", handle: "bot" })).body.code).toBe("BAD_REQUEST");
      expect((await owner.call("create_invite", { role: "viewer", email: "nope" })).body.code).toBe("BAD_REQUEST");
      expect((await editor.call("list_shares", {})).body.code).toBe("FORBIDDEN");
      expect((await editor.call("create_invite", { role: "viewer", handle: "bot" })).body.code).toBe("FORBIDDEN");
    } finally {
      await owner.client.close();
      await editor.client.close();
    }
  }, 60_000);
});
