import { Button, EmptyState, IconButton, Input, Menu, MoreIcon, PlusIcon, Select, useToast } from "agentic-design/react";
import type { Field, FieldInput, Row, Sort, Table } from "agentic-tables/client";
import { useCallback, useEffect, useState } from "react";
import { client, failure } from "./api";
import { ConfirmDialog, NewColumnDialog, NewRowDialog } from "./Dialogs";
import { Grid } from "./Grid";
import { filterOf, OP_LABEL, OPS, type Condition } from "./values";

const PAGE = 100;
type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; table: Table; rows: Row[]; next?: string };
const NO_FILTER: Condition = { field: "", op: "contains", value: "" };

export function TableView({ tableId, onGone }: { tableId: string; onGone: () => void }) {
  const toast = useToast();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [draft, setDraft] = useState<Condition>(NO_FILTER);
  const [applied, setApplied] = useState<Condition>(NO_FILTER);
  const [sort, setSort] = useState<{ field: string; direction: "asc" | "desc" }>({ field: "", direction: "asc" });
  const [dialog, setDialog] = useState<"column" | "row" | "table" | { row: Row } | { field: Field } | null>(null);
  const close = (open: boolean) => open || setDialog(null);

  const read = useCallback(
    async (cursor?: string) => {
      try {
        const table = await client.getTable(tableId);
        const filter = filterOf(table.fields.find((f) => f.id === applied.field), applied);
        const order: Sort | undefined = sort.field ? { field: sort.field, direction: sort.direction } : undefined;
        const page = await client.queryRows(tableId, { filter, sort: order, limit: PAGE, cursor });
        setLoad((was) => ({ state: "ready", table, rows: cursor && was.state === "ready" ? [...was.rows, ...page.items] : page.items, next: page.nextCursor }));
      } catch (error) {
        setLoad({ state: "error", message: failure(error) });
      }
    },
    [tableId, applied, sort],
  );
  useEffect(() => {
    setLoad({ state: "loading" });
    void read();
  }, [read]);
  useEffect(() => { setDraft(NO_FILTER); setApplied(NO_FILTER); setSort({ field: "", direction: "asc" }); }, [tableId]);

  /** Run a write. On failure show the reason and keep the dialog open. On success read the page again. */
  async function run(write: () => Promise<unknown>): Promise<string | null> {
    try {
      await write();
      await read();
      return null;
    } catch (error) {
      return failure(error);
    }
  }

  if (load.state === "loading") return <p role="status" className="status"><span className="ad-spinner" aria-hidden="true" /> Loading table…</p>;
  if (load.state === "error")
    return <EmptyState title="The table did not load" description={<span role="alert">{load.message}</span>} action={<Button onClick={() => { setLoad({ state: "loading" }); void read(); }}>Try again</Button>} />;

  const { table, rows, next } = load;
  const field = table.fields.find((f) => f.id === draft.field);
  const ops = field ? OPS[field.type]! : [];
  const needsValue = field && !["is_empty", "not_empty"].includes(draft.op);
  const failed = (title: string) => (message: string | null) => {
    if (message !== null) toast({ title, description: message, tone: "danger" });
    return message;
  };

  return (
    <section aria-labelledby="table-title">
      <div className="head">
        <h1 id="table-title">{table.name}</h1>
        <div className="head__actions">
          <Button variant="secondary" onClick={() => setDialog("column")}><PlusIcon aria-hidden="true" /> Add column</Button>
          <Button onClick={() => setDialog("row")}><PlusIcon aria-hidden="true" /> Add row</Button>
          <Button variant="ghost" onClick={() => setDialog("table")}>Delete table</Button>
        </div>
      </div>

      <form className="query" aria-label="Filter and sort" onSubmit={(e) => { e.preventDefault(); setApplied(draft); }}>
        <Select label="Filter column" value={draft.field} onChange={(e) => { const f = table.fields.find((x) => x.id === e.target.value); setDraft({ field: e.target.value, op: f ? OPS[f.type]![0]! : "contains", value: "" }); }}>
          <option value="">(no filter)</option>
          {table.fields.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </Select>
        {field ? (
          <Select label="Condition" value={draft.op} onChange={(e) => setDraft({ ...draft, op: e.target.value })}>
            {ops.map((o) => <option key={o} value={o}>{OP_LABEL[o]}</option>)}
          </Select>
        ) : null}
        {needsValue ? <Input label="Value" type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"} value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })} /> : null}
        <Button type="submit" variant="secondary">Apply filter</Button>
        {applied.field ? <Button type="button" variant="ghost" onClick={() => { setDraft(NO_FILTER); setApplied(NO_FILTER); }}>Clear filter</Button> : null}
        <Select label="Sort by" value={sort.field} onChange={(e) => setSort({ ...sort, field: e.target.value })}>
          <option value="">Order added</option>
          {table.fields.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          <option value="updatedAt">Last edited</option>
        </Select>
        <Select label="Direction" value={sort.direction} onChange={(e) => setSort({ ...sort, direction: e.target.value as "asc" | "desc" })}>
          <option value="asc">Ascending</option>
          <option value="desc">Descending</option>
        </Select>
      </form>

      {table.fields.length === 0 ? (
        <EmptyState title="No columns yet" description="Add a column to start." action={<Button onClick={() => setDialog("column")}>Add column</Button>} />
      ) : (
        <>
          {rows.length > 0 ? <p className="hint">Use the arrow keys to move, Enter to edit a cell, and Escape to cancel.</p> : null}
          <Grid
            table={table}
            rows={rows}
            onCommit={async (row, f, value) => failed("The cell did not save")(await run(() => client.updateRow(row.id, { [f.name]: value })))}
            onDelete={(row) => setDialog({ row })}
            header={(f) => (
              <Menu trigger={<IconButton label={`Column options for ${f.name}`} icon={<MoreIcon aria-hidden="true" />} size="sm" variant="ghost" />} items={[{ label: "Delete column", danger: true, onSelect: () => setDialog({ field: f }) }]} />
            )}
          />
          {rows.length === 0 ? (
            <EmptyState title={applied.field ? "No rows match" : "No rows yet"} description={applied.field ? "Change or clear the filter." : "Add the first row."} action={applied.field ? undefined : <Button onClick={() => setDialog("row")}>Add row</Button>} />
          ) : null}
          {next ? <Button variant="secondary" onClick={() => void read(next)}>Load more rows</Button> : null}
        </>
      )}

      <NewColumnDialog open={dialog === "column"} onOpenChange={close} create={(f: FieldInput) => run(() => client.addField(tableId, f))} />
      <NewRowDialog open={dialog === "row"} onOpenChange={close} table={table} create={(values) => run(() => client.insertRow(tableId, values as never))} />
      <ConfirmDialog
        open={dialog === "table"}
        onOpenChange={close}
        title={`Delete ${table.name}?`}
        description="This deletes the table and all its rows. It cannot be undone."
        label="Delete table"
        confirm={async () => {
          try { await client.deleteTable(tableId); onGone(); return null; } catch (error) { return failure(error); }
        }}
      />
      <ConfirmDialog
        open={typeof dialog === "object" && dialog !== null && "row" in dialog}
        onOpenChange={close}
        title="Delete this row?"
        description="The row is deleted. It cannot be undone."
        label="Delete row"
        confirm={() => run(() => client.deleteRow((dialog as { row: Row }).row.id))}
      />
      <ConfirmDialog
        open={typeof dialog === "object" && dialog !== null && "field" in dialog}
        onOpenChange={close}
        title="Delete this column?"
        description="The column and its values are deleted. It cannot be undone."
        label="Delete column"
        confirm={() => run(() => client.deleteField(tableId, (dialog as { field: Field }).field.id))}
      />
    </section>
  );
}
