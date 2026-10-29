import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The `./ui` export points at files that `npm run build` makes. This runs on the built package.
const dist = (name: string) => new URL(`../dist/${name}`, import.meta.url);

describe("agentic-tables/ui export", () => {
  const exports = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { exports: Record<string, unknown> }).exports;

  it("points at built files", () => {
    expect(exports["./ui"]).toEqual({ types: "./dist/embed.d.ts", import: "./dist/embed.js" });
    expect(exports["./ui.css"]).toBe("./dist/embed.css");
    for (const f of ["embed.js", "embed.d.ts", "embed.css"]) expect(existsSync(dist(f)), f).toBe(true);
  });

  it("exports mount, and the types name the options", async () => {
    const mod = await import(dist("embed.js").href);
    expect(typeof mod.mount).toBe("function");
    expect(readFileSync(dist("embed.d.ts"), "utf8")).toMatch(/interface TablesUiOptions[\s\S]*baseUrl: string[\s\S]*getToken/);
  });
});
