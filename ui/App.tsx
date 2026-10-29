import { AppShell, Button, EmptyState, PlusIcon, Select, SidebarNav, useTheme, type ThemePreference } from "agentic-design/react";
import type { Base, Table } from "agentic-tables/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { failure, useClient } from "./api";
import { NewTableDialog } from "./Dialogs";
import { TableView } from "./TableView";

const DEFAULT_BASE = "My tables";
type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; base: Base; tables: Table[] };

/** The table id in the URL hash, as `#/t/<id>`. */
const routeId = () => /^#\/t\/(.+)$/.exec(location.hash)?.[1] ?? null;

/** The theme control. It needs a `ThemeProvider` above it, which sets `data-theme` on the page, so a host opts in. */
function ThemePicker() {
  const { preference, setPreference } = useTheme();
  return (
    <Select label="Theme" hideLabel value={preference} onChange={(e) => setPreference(e.target.value as ThemePreference)}>
      <option value="system">Theme: system</option>
      <option value="light">Theme: light</option>
      <option value="dark">Theme: dark</option>
    </Select>
  );
}

/** The app. `frame` draws the design package's app shell, with its banner, main landmark, and skip link. Without it the
 * app draws a plain block, for a host page that has its own landmarks. */
export function App({ themePicker = false, frame = true }: { themePicker?: boolean; frame?: boolean }) {
  const client = useClient();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [route, setRoute] = useState(routeId());
  const [creating, setCreating] = useState(false);

  const latest = useRef(0);
  const read = useCallback(async () => {
    const mine = ++latest.current;
    try {
      // The first visit makes a base to hold the tables. Later visits use the first base.
      const base = (await client.listBases())[0] ?? (await client.createBase(DEFAULT_BASE));
      const tables = await client.listTables(base.id);
      if (mine === latest.current) setLoad({ state: "ready", base, tables });
    } catch (error) {
      if (mine === latest.current) setLoad({ state: "error", message: failure(error) });
    }
  }, [client]);
  useEffect(() => { void read(); }, [read]);
  useEffect(() => {
    const on = () => setRoute(routeId());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);

  const tables = load.state === "ready" ? load.tables : [];
  const current = tables.find((t) => t.id === route) ?? null;
  const topbar = (
    <>
      {themePicker ? <ThemePicker /> : null}
      <Button onClick={() => setCreating(true)} disabled={load.state !== "ready"}><PlusIcon aria-hidden="true" /> New table</Button>
    </>
  );

  let body;
  if (load.state === "loading") body = <p role="status" className="status"><span className="ad-spinner" aria-hidden="true" /> Loading tables…</p>;
  else if (load.state === "error")
    body = <EmptyState title="The tables did not load" description={<span role="alert">{load.message}</span>} action={<Button onClick={() => { setLoad({ state: "loading" }); void read(); }}>Try again</Button>} />;
  else if (current) body = <TableView key={current.id} tableId={current.id} onGone={() => { location.hash = ""; void read(); }} />;
  else if (tables.length === 0) body = <EmptyState title="No tables yet" description="Make a table, then add columns and rows." action={<Button onClick={() => setCreating(true)}>New table</Button>} />;
  else body = <EmptyState title="Pick a table" description="Choose a table in the list." />;

  const sidebar = <SidebarNav label="Tables" items={tables.map((t) => ({ href: `#/t/${t.id}`, label: t.name, current: t.id === route }))} />;
  const dialog =
    load.state === "ready" ? (
      <NewTableDialog
        open={creating}
        onOpenChange={setCreating}
        create={async (name) => {
          try {
            const table = await client.createTable(load.base.id, name);
            await read();
            location.hash = `#/t/${table.id}`;
            return null;
          } catch (error) {
            return failure(error);
          }
        }}
      />
    ) : null;

  if (!frame) {
    return (
      <div className="embed">
        <div className="embed__bar">{topbar}</div>
        <div className="embed__body">
          {sidebar}
          <div className="embed__content">{body}</div>
        </div>
        {dialog}
      </div>
    );
  }
  return (
    <AppShell brand="Tables" topbar={topbar} sidebar={sidebar}>
      {body}
      {dialog}
    </AppShell>
  );
}
