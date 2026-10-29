// Failure cases for the unsafe-mode D1 wrapper: a reported region is never changed, and batch gets real statements.
import { describe, expect, test } from "vitest";
import type { D1Like } from "agentic-identity/cloudflare";
import { reportingRegion } from "./worker.js";

function fake(served: string | undefined) {
  const batched: unknown[] = [];
  const statement: any = {
    bind: () => statement,
    first: async () => null,
    all: async () => ({ results: [], meta: served === undefined ? {} : { served_by_region: served } }),
    run: async () => ({}),
  };
  const db: D1Like = { prepare: () => statement, batch: async (s) => (batched.push(...s), []) };
  return { db, statement, batched };
}

describe("reportingRegion", () => {
  test("fills a missing region with the declared one", async () => {
    const out = await reportingRegion(fake(undefined).db, "eu").prepare("x").bind(1).all();
    expect(out.meta?.served_by_region).toBe("WEUR");
  });
  test("keeps a region that D1 reports, even outside the claim", async () => {
    const out = await reportingRegion(fake("ENAM").db, "eu").prepare("x").all();
    expect(out.meta?.served_by_region).toBe("ENAM");
  });
  test("passes the real statements to batch", async () => {
    const { db, statement, batched } = fake(undefined);
    const wrapped = reportingRegion(db, "us");
    await wrapped.batch([wrapped.prepare("a").bind(1), wrapped.prepare("b")]);
    expect(batched).toEqual([statement, statement]);
  });
});
