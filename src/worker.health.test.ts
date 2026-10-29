// The Worker answers GET /health with no credential and no database. These are the ways it can fail:
// it asks for a credential, it opens the database, it adds fields to the body, it reports a stale name or
// version, or it answers a path or method it should not.
import { describe, expect, test } from "vitest";
import pkg from "../package.json" with { type: "json" };
import worker from "./worker.js";

describe("GET /health", () => {
  test("answers 200 with name and version, and no credential or database", async () => {
    const response = await worker.fetch(new Request("https://tables.example.org/health"), {});
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ ok: true, name: "agentic-tables", version: pkg.version });
  });

  test("answers only GET on the exact path", async () => {
    for (const [method, path] of [
      ["POST", "/health"],
      ["GET", "/health/"],
      ["GET", "/healthz"],
      ["GET", "/api/v1/health"],
    ] as const) {
      const response = await worker.fetch(new Request(`https://tables.example.org${path}`, { method }), {});
      expect(await response.text()).not.toContain('"ok":true');
    }
  });
});
