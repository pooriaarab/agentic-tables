// The tables app for a page that embeds it: `agentic-tables/ui`. The page gives a base URL and a callback that returns the
// token. The web UI that the Worker serves renders the same component. React and react-dom are peer dependencies.
import { createRoot } from "react-dom/client";
import { ThemeProvider, ToastProvider, TooltipProvider } from "agentic-design/react";
import { createClient, type ClientPrincipal, type TablesClient } from "../src/client.js";
import "./app.css";
import { App } from "./App.js";
import { ClientContext } from "./api.js";

export type { ClientPrincipal, TablesClient };

export interface TablesUiOptions {
  /** The origin of the Worker, such as `https://tables.example.com`. */
  baseUrl: string;
  /** Called before each request. Return the bearer token, or nothing to send none. A throw fails that request, and the UI shows it. */
  getToken?: () => string | undefined | Promise<string | undefined>;
  /** The caller as principal headers. The Worker proves nothing from them yet, so use them against a local Worker only. */
  principal?: ClientPrincipal;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Show a theme control, and let the app set `data-theme` on the page. Off by default, so the page keeps its own theme. */
  themePicker?: boolean;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Only `https:` carries a token safely. `http:` is for a Worker on this machine. */
function checkBaseUrl(value: unknown): void {
  let url: URL | undefined;
  try {
    url = typeof value === "string" ? new URL(value) : undefined;
  } catch {
    url = undefined;
  }
  if (!url || (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname)))) {
    throw new TypeError("the tables UI needs a baseUrl that starts with https:// (http:// only for localhost)");
  }
}

/** A client that asks the callback for the token on each request, so a token that expires is replaced and never kept. */
function clientFor(options: TablesUiOptions): TablesClient {
  if (!options) throw new TypeError("the tables UI needs options with a baseUrl");
  checkBaseUrl(options.baseUrl);
  if (options.getToken !== undefined && typeof options.getToken !== "function") throw new TypeError("getToken must be a function");
  const inner = options.fetch ?? globalThis.fetch?.bind(globalThis);
  if (typeof inner !== "function") throw new TypeError("no fetch available: pass options.fetch");
  const { getToken } = options;
  const withToken: typeof fetch = async (input, init) => {
    const token = getToken ? await getToken() : undefined;
    if (token === undefined || token === "") return inner(input, init);
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${token}`);
    return inner(input, { ...init, headers });
  };
  return createClient({ baseUrl: options.baseUrl, principal: options.principal, fetch: withToken });
}

/** The app with a client above it. It needs the theme, tooltip, and toast providers above it. `mount` adds them. */
function TablesApp({ client, themePicker }: { client: TablesClient; themePicker?: boolean }) {
  return (
    <ClientContext.Provider value={client}>
      <App themePicker={themePicker} />
    </ClientContext.Provider>
  );
}

export interface MountedTables {
  /** Use other options in the same place. Bad options throw and keep the app as it is. */
  update(options: TablesUiOptions): void;
  /** Remove the app and its listeners. A second call does nothing. */
  unmount(): void;
}

const mounted = new WeakSet<HTMLElement>();

/** Render the app into an element, for a page that does not use React itself. */
export function mount(element: HTMLElement, options: TablesUiOptions): MountedTables {
  if (!(element instanceof HTMLElement)) throw new TypeError("mount needs an element");
  if (mounted.has(element)) throw new TypeError("the tables UI is already mounted in this element");
  let client = clientFor(options);
  let picker = options.themePicker === true;
  const root = createRoot(element);
  mounted.add(element);
  let gone = false;
  const render = () => {
    const app = (
      <TooltipProvider>
        <ToastProvider>
          <TablesApp client={client} themePicker={picker} />
        </ToastProvider>
      </TooltipProvider>
    );
    root.render(picker ? <ThemeProvider>{app}</ThemeProvider> : app);
  };
  render();
  return {
    update(next) {
      if (gone) return;
      client = clientFor(next);
      picker = next.themePicker === true;
      render();
    },
    unmount() {
      if (gone) return;
      gone = true;
      root.unmount();
      mounted.delete(element);
    },
  };
}
