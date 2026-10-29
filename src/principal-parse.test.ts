// Failure cases, written before the fix: a kind:id string with no colon must fail, not guess a kind
// ("humanX" must not become kind human), and an id outside the identity rule must fail.
import { describe, expect, it } from "vitest";
import { callerFromHeaders } from "./caller.js";
import { parseActor } from "./context.js";

describe("principal parsing", () => {
  it.each(["humanX", "agent1", "humans", "human", "human:", ":x", "human:a@b.c"])("parseActor refuses %s", (spec) => {
    expect(() => parseActor(spec)).toThrow(/actor must look like/);
  });
  it("parseActor reads a good spec", () => {
    expect(parseActor("agent:claude")).toEqual({ kind: "agent", id: "claude" });
  });
  it.each(["humanowen", "agent1"])("a chain step %s with no colon is refused", async (chain) => {
    const get = (name: string) => ({ "x-principal-id": "bot", "x-principal-kind": "agent_of_human", "x-principal-chain": chain })[name];
    await expect(callerFromHeaders(get)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
});
