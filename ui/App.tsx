import { AppShell, Button, EmptyState, PlusIcon, Select, SidebarNav, useTheme, type ThemePreference } from "agentic-design/react";
import type { Base, Table } from "agentic-tables/client";
import { useCallback, useEffect, useState } from "react";
import { failure, useClient } from "./api";
import { NewTableDialog } from "./Dialogs";
import { TableView } from "./TableView";

const DEFAULT_BASE = "My tables";
type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; base: Base; tables: Table[] };

/** The table id in the URL hash, as `#/t/<id>`. */
const routeId = () => /^#\/t\/(.+)$/.exec(location.hash)?.[1] ?? null;

export function App() {
  const client = useClient();
  const { preference, setPreference } = useTheme();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [route, setRoute] = useState(routeId());
  const [creating, setCreating] = useState(false);

  const read = useCallback(async () => {
    try {
      // The first visit makes a base to hold the tables. Later visits use the first base.
      const base = (await client.listBases())[0] ?? (await client.createBase(DEFAULT_BASE));
      setLoad({ state: "ready", base, tables: await client.listTables(base.id) });
    } catch (error) {
      setLoad({ state: "error", message: failure(error) });
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
      <Select label="Theme" hideLabel value={preference} onChange={(e) => setPreference(e.target.value as ThemePreference)}>
        <option value="system">Theme: system</option>
        <option value="light">Theme: light</option>
        <option value="dark">Theme: dark</option>
      </Select>
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

  return (
    <AppShell
      brand="Tables"
      topbar={topbar}
      sidebar={<SidebarNav label="Tables" items={tables.map((t) => ({ href: `#/t/${t.id}`, label: t.name, current: t.id === route }))} />}
    >
      {body}
      {load.state === "ready" ? (
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
      ) : null}
    </AppShell>
  );
}
