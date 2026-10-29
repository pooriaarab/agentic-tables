// @vitest-environment jsdom
// Ways the embed can fail, each one a test below: no or blank base URL; a getToken that is not a function; a token that is
// read once and kept; an empty token sent as a header; a getToken that throws; unmount that leaves the page dirty or throws
// the second time; update with bad options that breaks the app; update that keeps the old client.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, type MountedTables } from "./embed.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no matchMedia, and the theme provider asks for it.
window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as never;

const base = { id: "b1", name: "My tables" };
const table = (name: string) => ({ id: `t-${name}`, baseId: "b1", name, fields: [], createdAt: "", updatedAt: "" });

/** A fake API. It records each request, and answers the base and table lists. */
function fakeApi(tables: string[]) {
  const seen: { url: string; headers: Headers }[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, headers: new Headers(init?.headers) });
    const body = url.endsWith("/bases") ? { items: [base] } : { items: tables.map(table) };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, seen };
}

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

let host: HTMLElement;
let mounted: MountedTables | undefined;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
});
afterEach(async () => {
  if (mounted) await act(async () => mounted!.unmount());
  mounted = undefined;
  host.remove();
});

describe("mount", () => {
  it.each([
    ["no options", undefined],
    ["no base URL", { baseUrl: undefined }],
    ["a blank base URL", { baseUrl: "  " }],
    ["a getToken that is not a function", { baseUrl: "https://t.example", getToken: "secret" }],
  ])("throws for %s and renders nothing", (_label, options) => {
    expect(() => mount(host, options as never)).toThrow(TypeError);
    expect(host.innerHTML).toBe("");
  });

  it("lists the tables from the base URL and sends the token from the callback on each request", async () => {
    const api = fakeApi(["Tasks", "People"]);
    let n = 0;
    const getToken = vi.fn(() => `token-${++n}`);
    await act(async () => void (mounted = mount(host, { baseUrl: "https://t.example", getToken, fetch: api.fetch })));
    await settle();
    expect(host.querySelector("nav")?.textContent).toContain("Tasks");
    expect(host.querySelector("nav")?.textContent).toContain("People");
    // StrictMode runs the first load twice in a test, so check the set of URLs, not the count.
    expect(new Set(api.seen.map((r) => r.url))).toEqual(new Set(["https://t.example/api/v1/tables/bases", "https://t.example/api/v1/tables/bases/b1/tables"]));
    const tokens = api.seen.map((r) => r.headers.get("authorization"));
    expect(new Set(tokens).size).toBe(tokens.length);
    expect(tokens.every((t) => /^Bearer token-\d+$/.test(t ?? ""))).toBe(true);
    expect(getToken).toHaveBeenCalledTimes(tokens.length);
  });

  it("sends no authorization header when the callback gives an empty token or none", async () => {
    const api = fakeApi([]);
    await act(async () => void (mounted = mount(host, { baseUrl: "https://t.example", getToken: () => "", fetch: api.fetch })));
    await settle();
    expect(api.seen.length).toBeGreaterThan(0);
    expect(api.seen.every((r) => r.headers.get("authorization") === null)).toBe(true);
  });

  it("shows a failure and sends no request when the callback throws", async () => {
    const api = fakeApi([]);
    const getToken = () => {
      throw new Error("no session");
    };
    await act(async () => void (mounted = mount(host, { baseUrl: "https://t.example", getToken, fetch: api.fetch })));
    await settle();
    expect(api.fetch).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
  });

  it("update uses the new options, and bad options throw and keep the app", async () => {
    const first = fakeApi(["Tasks"]);
    const second = fakeApi(["Notes"]);
    await act(async () => void (mounted = mount(host, { baseUrl: "https://one.example", fetch: first.fetch })));
    await settle();
    expect(() => mounted!.update({ baseUrl: "" })).toThrow(TypeError);
    expect(host.querySelector("nav")?.textContent).toContain("Tasks");
    await act(async () => mounted!.update({ baseUrl: "https://two.example", fetch: second.fetch }));
    await settle();
    expect(second.seen[0]!.url).toBe("https://two.example/api/v1/tables/bases");
    expect(host.querySelector("nav")?.textContent).toContain("Notes");
  });

  it("unmount empties the element, and a second unmount does nothing", async () => {
    const api = fakeApi(["Tasks"]);
    await act(async () => void (mounted = mount(host, { baseUrl: "https://t.example", fetch: api.fetch })));
    await settle();
    expect(host.innerHTML).not.toBe("");
    await act(async () => mounted!.unmount());
    expect(host.innerHTML).toBe("");
    expect(() => mounted!.unmount()).not.toThrow();
    expect(() => mounted!.update({ baseUrl: "https://t.example", fetch: api.fetch })).not.toThrow();
    expect(host.innerHTML).toBe("");
  });
});
