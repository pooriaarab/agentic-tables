// @vitest-environment jsdom
// Ways the embed can fail, each one a test below: no or blank base URL; a getToken that is not a function; a token that is
// read once and kept; an empty token sent as a header; a getToken that throws; unmount that leaves the page dirty or throws
// the second time; update with bad options that breaks the app; update that keeps the old client; `frame: false` that still
// draws the app's own banner, main landmark, or skip link inside the host page, or loses the table list or the New table button.
import { act } from "react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, type MountedTables, type TablesUiOptions } from "./embed.js";

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
    const path = url.split("/api/v1/tables")[1]!.split("?")[0]!;
    let body: unknown = { items: tables.map(table) };
    if (path === "/bases") body = { items: [base] };
    else if (path.startsWith("/tables/")) body = path.endsWith("/rows") ? { items: [] } : table(decodeURIComponent(path.split("/")[2]!).slice(2));
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, seen };
}

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

/** The axe rules that catch a second or nested main, and a landmark out of place. Axe runs them on the host element, so the page-level rules do not apply. */
const LANDMARK_RULES = { runOnly: { type: "rule" as const, values: ["landmark-no-duplicate-main", "landmark-main-is-top-level", "landmark-unique"] } };

/** A page with its own banner and main, as a site has. The app mounts inside the main, and the slot it mounts into is returned. */
async function mountInSitePage(options: TablesUiOptions) {
  host.innerHTML = "<header>Site</header><main></main>";
  const slot = document.createElement("div");
  host.querySelector("main")!.append(slot);
  await act(async () => void (mounted = mount(slot, options)));
  return slot;
}

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
    ["a base URL with no scheme", { baseUrl: "tables.example.com" }],
    ["a base URL with http on a remote host", { baseUrl: "http://tables.example.com" }],
    ["a base URL with another scheme", { baseUrl: "ftp://tables.example.com" }],
    ["a getToken that is not a function", { baseUrl: "https://t.example", getToken: "secret" }],
  ])("throws for %s and renders nothing", (_label, options) => {
    expect(() => mount(host, options as never)).toThrow(TypeError);
    expect(host.innerHTML).toBe("");
  });

  it("throws for no element, and for a second mount in the same element", async () => {
    const api = fakeApi([]);
    expect(() => mount(null as never, { baseUrl: "https://t.example", fetch: api.fetch })).toThrow(TypeError);
    await act(async () => void (mounted = mount(host, { baseUrl: "https://t.example", fetch: api.fetch })));
    expect(() => mount(host, { baseUrl: "https://t.example", fetch: api.fetch })).toThrow(TypeError);
  });

  it("accepts http for localhost", async () => {
    const api = fakeApi([]);
    await act(async () => void (mounted = mount(host, { baseUrl: "http://127.0.0.1:8791", fetch: api.fetch })));
    await settle();
    expect(api.seen[0]!.url).toBe("http://127.0.0.1:8791/api/v1/tables/bases");
  });

  it("leaves the theme of the page alone, on mount and on unmount", async () => {
    document.documentElement.setAttribute("data-theme", "dark");
    const api = fakeApi([]);
    await act(async () => void (mounted = mount(host, { baseUrl: "https://t.example", fetch: api.fetch })));
    await settle();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(host.textContent).not.toContain("Theme");
    await act(async () => mounted!.unmount());
    mounted = undefined;
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    document.documentElement.removeAttribute("data-theme");
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

  it("update sends the reads of an open table through the new client", async () => {
    const first = fakeApi(["Tasks"]);
    const second = fakeApi(["Tasks"]);
    location.hash = "#/t/t-Tasks";
    await act(async () => void (mounted = mount(host, { baseUrl: "https://one.example", getToken: () => "old", fetch: first.fetch })));
    await settle();
    expect(first.seen.some((r) => r.url.endsWith("/tables/t-Tasks"))).toBe(true);
    await act(async () => mounted!.update({ baseUrl: "https://two.example", getToken: () => "new", fetch: second.fetch }));
    await settle();
    const reads = second.seen.filter((r) => r.url.endsWith("/tables/t-Tasks"));
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((r) => r.headers.get("authorization") === "Bearer new")).toBe(true);
    location.hash = "";
  });

  it("draws its own banner and main landmarks by default", async () => {
    const api = fakeApi(["Tasks"]);
    await act(async () => void (mounted = mount(host, { baseUrl: "https://t.example", fetch: api.fetch })));
    await settle();
    expect(host.querySelector("main")).not.toBeNull();
  });

  it("with frame: false, draws no landmark of its own but keeps the table list and the New table button", async () => {
    const api = fakeApi(["Tasks"]);
    await act(async () => void (mounted = mount(host, { baseUrl: "https://t.example", fetch: api.fetch, frame: false })));
    await settle();
    expect(host.querySelector("main, header, [role=main], [role=banner], aside, [role=complementary]")).toBeNull();
    expect(host.querySelector('a[href^="#main"], .agd-skip-link')).toBeNull();
    expect(host.querySelector("nav")?.textContent).toContain("Tasks");
    expect([...host.querySelectorAll("button")].some((b) => b.textContent?.includes("New table"))).toBe(true);
    await act(async () => mounted!.update({ baseUrl: "https://t.example", fetch: api.fetch }));
    await settle();
    expect(host.querySelector("main")).not.toBeNull();
  });

  it("with frame: false, a page that has its own banner and main passes the axe landmark rules", async () => {
    const api = fakeApi(["Tasks"]);
    const slot = await mountInSitePage({ baseUrl: "https://t.example", fetch: api.fetch, frame: false });
    await settle();
    expect((await axe.run(host, LANDMARK_RULES)).violations.map((v) => v.id)).toEqual([]);
    expect(slot.textContent).toContain("Tasks");
  });

  it("the default frame fails the axe landmark rules on that same page", async () => {
    const api = fakeApi(["Tasks"]);
    await mountInSitePage({ baseUrl: "https://t.example", fetch: api.fetch });
    await settle();
    const ids = (await axe.run(host, LANDMARK_RULES)).violations.map((v) => v.id);
    expect(ids).toContain("landmark-no-duplicate-main");
  });

  it("throws for a frame that is not a boolean", () => {
    expect(() => mount(host, { baseUrl: "https://t.example", frame: "no" } as never)).toThrow(TypeError);
    expect(host.innerHTML).toBe("");
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

describe("base and table options", () => {
  const bases = [{ id: "b1", name: "Mine" }, { id: "b2", name: "Shared" }];
  const inBase = (baseId: string, name: string) => ({ id: `t-${name}`, baseId, name, fields: [], createdAt: "", updatedAt: "" });
  const lists: Record<string, ReturnType<typeof inBase>[]> = { b1: [inBase("b1", "Tasks")], b2: [inBase("b2", "Budget"), inBase("b2", "Plans")] };
  const fetch = (async (input: RequestInfo | URL) => {
    const path = String(input).split("/api/v1/tables")[1]!;
    let body: unknown = { items: bases };
    const m = /^\/bases\/([^/]+)\/tables$/.exec(path);
    if (m) body = { items: lists[m[1]!] ?? [] };
    else if (path.startsWith("/tables/")) body = path.endsWith("/rows") ? { items: [] } : inBase("b2", "Budget");
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  const navText = () => host.querySelector("nav")?.textContent ?? "";
  const open = async (extra: Partial<TablesUiOptions>) => {
    await act(async () => void (mounted = mount(host, { baseUrl: "https://t.example", fetch, ...extra })));
    await settle();
  };
  afterEach(() => { location.hash = ""; });

  it("opens the first base by default", async () => {
    await open({});
    expect(navText()).toContain("Tasks");
  });

  it("opens the base named by baseId, a shared one", async () => {
    await open({ baseId: "b2" });
    expect(navText()).toContain("Budget");
    expect(navText()).not.toContain("Tasks");
  });

  it("shows an error, and no other base, for a base the caller cannot read", async () => {
    await open({ baseId: "nope" });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("not found");
    expect(navText()).not.toContain("Tasks");
  });

  it("opens the base that holds tableId, and marks that table as current", async () => {
    await open({ tableId: "t-Plans" });
    expect(navText()).toContain("Budget");
    expect(host.querySelector('nav [aria-current="page"]')?.textContent).toContain("Plans");
  });

  it("lets the hash win over tableId on mount", async () => {
    location.hash = "#/t/t-Budget";
    await open({ tableId: "t-Plans" });
    expect(host.querySelector('nav [aria-current="page"]')?.textContent).toContain("Budget");
  });

  it("lists every readable base in the switcher and switches", async () => {
    await open({ baseSwitcher: true });
    const select = host.querySelector("select") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["Base: Mine", "Base: Shared"]);
    await act(async () => {
      select.value = "b2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    expect(navText()).toContain("Budget");
  });

  it("draws no switcher unless asked", async () => {
    await open({});
    expect(host.querySelector("select")).toBeNull();
  });

  it.each([["baseId", ""], ["tableId", 3], ["baseSwitcher", "yes"]])("throws for a bad %s", (key, value) => {
    expect(() => mount(host, { baseUrl: "https://t.example", fetch, [key]: value } as never)).toThrow(TypeError);
  });

  it("has no axe violations with the switcher on", async () => {
    await open({ baseSwitcher: true, frame: false });
    const result = await axe.run(host, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag22aa"] }, rules: { region: { enabled: false } } });
    expect(result.violations.map((v) => v.id)).toEqual([]);
  });
});
