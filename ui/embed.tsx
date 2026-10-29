// The tables app for a page that embeds it: `agentic-tables/ui`. The page gives a base URL and a callback that returns the
// token. The web UI that the Worker serves renders the same component. React and react-dom are peer dependencies.
import { StrictMode } from "react";
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
}

/** A client that asks the callback for the token on each request, so a token that expires is replaced and never kept. */
export function clientFor(options: TablesUiOptions): TablesClient {
  if (!options || typeof options.baseUrl !== "string" || options.baseUrl.trim() === "") throw new TypeError("the tables UI needs a baseUrl");
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
export function TablesApp({ client }: { client: TablesClient }) {
  return (
    <ClientContext.Provider value={client}>
      <App />
    </ClientContext.Provider>
  );
}

export interface MountedTables {
  /** Use other options in the same place. Bad options throw and keep the app as it is. */
  update(options: TablesUiOptions): void;
  /** Remove the app and its listeners. A second call does nothing. */
  unmount(): void;
}

/** Render the app into an element, for a page that does not use React itself. */
export function mount(element: HTMLElement, options: TablesUiOptions): MountedTables {
  let client = clientFor(options);
  const root = createRoot(element);
  let gone = false;
  const render = () =>
    root.render(
      <StrictMode>
        <ThemeProvider>
          <TooltipProvider>
            <ToastProvider>
              <TablesApp client={client} />
            </ToastProvider>
          </TooltipProvider>
        </ThemeProvider>
      </StrictMode>,
    );
  render();
  return {
    update(next) {
      if (gone) return;
      client = clientFor(next);
      render();
    },
    unmount() {
      if (gone) return;
      gone = true;
      root.unmount();
    },
  };
}
