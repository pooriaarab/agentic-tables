import { AppShell, Button, EmptyState, PlusIcon, Select, SidebarNav, useTheme, type ThemePreference } from "agentic-design/react";
import type { Base, Table } from "agentic-tables/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { failure, UiError, useClient } from "./api";
import { NewTableDialog } from "./Dialogs";
import { TableView } from "./TableView";

const DEFAULT_BASE = "My tables";
const NOT_FOUND = "That table was not found, or you cannot read it.";
type Load = { state: "loading" } | { state: "error"; message: string; bases: Base[] } | { state: "ready"; base: Base; bases: Base[]; tables: Table[]; notice?: string };

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
export function App({ themePicker = false, frame = true, baseId, tableId, baseSwitcher = false }: { themePicker?: boolean; frame?: boolean; baseId?: string; tableId?: string; baseSwitcher?: boolean }) {
  const client = useClient();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [route, setRoute] = useState(routeId() ?? tableId ?? null);
  // The base the person chose in the switcher. It wins over the `baseId` option until that option changes.
  const [chosen, setChosen] = useState<string | undefined>(baseId);
  const routeNow = useRef(route);
  routeNow.current = route;
  // A changed option replaces what the person chose. The first render keeps the hash, which wins over `tableId`.
  const seen = useRef({ baseId, tableId });
  useEffect(() => {
    if (seen.current.baseId !== baseId) setChosen(baseId);
    if (seen.current.tableId !== tableId && tableId !== undefined) {
      // The next read looks for the base of this table, so set the target before it runs.
      routeNow.current = tableId;
      setRoute(tableId);
      // Keep the hash in step, so a click on the table that was open before still counts as a change. A deep link also
      // leaves the base the person picked in the switcher.
      location.hash = `#/t/${tableId}`;
      setChosen(baseId);
    }
    seen.current = { baseId, tableId };
  }, [baseId, tableId]);
  const [creating, setCreating] = useState(false);

  const latest = useRef(0);
  const read = useCallback(async () => {
    const mine = ++latest.current;
    let bases: Base[] = [];
    try {
      bases = await client.listBases();
      let base: Base | undefined;
      let tables: Table[] | undefined;
      let notice: string | undefined;
      if (chosen !== undefined) {
        // A named base that the caller cannot read is an error. It never falls back to another base.
        base = bases.find((b) => b.id === chosen);
        if (!base) throw new UiError("That base was not found, or you cannot read it.");
      } else if (routeNow.current) {
        // A link to a table with no base: open the base that holds it.
        for (const b of bases) {
          // A base that fails to list (just unshared or deleted) is skipped, so one bad base does not hide the table.
          const list = await client.listTables(b.id).catch(() => []);
          if (list.some((t) => t.id === routeNow.current)) { base = b; tables = list; break; }
        }
      }
      if (!base) {
        // The first visit makes a base to hold the tables. Later visits use the first base. A link that finds no base
        // makes none.
        base = bases[0];
        if (!base && routeNow.current) throw new UiError(NOT_FOUND);
        if (!base) { base = await client.createBase(DEFAULT_BASE); bases = [base]; }
      }
      tables ??= await client.listTables(base.id);
      if (routeNow.current && !tables.some((t) => t.id === routeNow.current)) notice = NOT_FOUND;
      if (mine === latest.current) setLoad({ state: "ready", base, bases, tables, notice });
    } catch (error) {
      if (mine === latest.current) setLoad({ state: "error", message: failure(error), bases });
    }
  // `tableId` is a dependency on purpose: a new link starts a new read, which looks for the base of that table.
  }, [client, chosen, tableId]);
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
      {baseSwitcher && load.state !== "loading" && load.bases.length > 0 ? (
        <Select label="Base" hideLabel value={chosen ?? (load.state === "ready" ? load.base.id : "")} onChange={(e) => { location.hash = ""; setRoute(null); setChosen(e.target.value); }}>
          {chosen !== undefined && !load.bases.some((b) => b.id === chosen) ? <option value={chosen} disabled>Base: not available</option> : null}
          {chosen === undefined && load.state === "error" ? <option value="" disabled>Base: choose one</option> : null}
          {load.bases.map((b) => <option key={b.id} value={b.id}>{`Base: ${b.name}`}</option>)}
        </Select>
      ) : null}
      {themePicker ? <ThemePicker /> : null}
      <Button onClick={() => setCreating(true)} disabled={load.state !== "ready"}><PlusIcon aria-hidden="true" /> New table</Button>
    </>
  );

  let body;
  if (load.state === "loading") body = <p role="status" className="status"><span className="agd-spinner" aria-hidden="true" /> Loading tables…</p>;
  else if (load.state === "error")
    body = <EmptyState title="The tables did not load" description={<span role="alert">{load.message}</span>} action={<Button onClick={() => { setLoad({ state: "loading" }); void read(); }}>Try again</Button>} />;
  else if (load.notice && !current) body = <EmptyState title="Table not found" description={<span role="alert">{load.notice}</span>} />;
  else if (current) body = <TableView key={current.id} tableId={current.id} onGone={() => { routeNow.current = null; setRoute(null); setChosen(load.base.id); location.hash = ""; void read(); }} />;
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
