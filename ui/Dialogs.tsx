import { Button, Checkbox, Dialog, DialogClose, Input, Select } from "agentic-design/react";
import type { Field, FieldInput, Table } from "agentic-tables/client";
import { useState, type FormEvent, type ReactNode } from "react";
import { Editor } from "./Editor";
import { draftOf, EDITABLE, valueOf, type Draft } from "./values";

type Props = { open: boolean; onOpenChange: (open: boolean) => void };

/** A dialog with a form. `submit` resolves to an error text, or `null` to close. */
function FormDialog({ open, onOpenChange, title, submitLabel, submit, children }: Props & { title: string; submitLabel: string; submit: () => Promise<string | null>; children: ReactNode }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const message = await submit();
    setBusy(false);
    setError(message);
    if (message === null) onOpenChange(false);
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { setError(null); onOpenChange(next); }}
      title={title}
      footer={<><DialogClose asChild><Button variant="ghost">Cancel</Button></DialogClose><Button type="submit" form="dialog-form" loading={busy}>{submitLabel}</Button></>}
    >
      <form id="dialog-form" onSubmit={onSubmit} className="form">
        {children}
        {error ? <p role="alert" className="form__error">{error}</p> : null}
      </form>
    </Dialog>
  );
}

export function NewTableDialog({ create, ...props }: Props & { create: (name: string) => Promise<string | null> }) {
  const [name, setName] = useState("");
  return (
    <FormDialog {...props} onOpenChange={(open) => { if (!open) setName(""); props.onOpenChange(open); }} title="New table" submitLabel="Create table" submit={async () => (await create(name)) ?? (setName(""), null)}>
      <Input label="Table name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
    </FormDialog>
  );
}

const TYPES = ["text", "long_text", "number", "checkbox", "date", "single_select", "multi_select"] as const;

export function NewColumnDialog({ create, ...props }: Props & { create: (field: FieldInput) => Promise<string | null> }) {
  const [name, setName] = useState("");
  const [type, setType] = useState<(typeof TYPES)[number]>("text");
  const [options, setOptions] = useState("");
  const [required, setRequired] = useState(false);
  const select = type === "single_select" || type === "multi_select";
  return (
    <FormDialog
      {...props}
      onOpenChange={(open) => { if (!open) { setName(""); setOptions(""); setRequired(false); setType("text"); } props.onOpenChange(open); }}
      title="New column"
      submitLabel="Add column"
      submit={async () => {
        const list = options.split(",").map((o) => o.trim()).filter(Boolean);
        const message = await create({ name, type, ...(select ? { options: list } : {}), ...(required ? { required } : {}) });
        if (message === null) { setName(""); setOptions(""); setRequired(false); }
        return message;
      }}
    >
      <Input label="Column name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
      <Select label="Type" value={type} onChange={(e) => setType(e.target.value as (typeof TYPES)[number])}>
        {TYPES.map((t) => <option key={t} value={t}>{t.replace("_", " ")}</option>)}
      </Select>
      {select ? <Input label="Options" hint="Separate options with commas." value={options} onChange={(e) => setOptions(e.target.value)} required /> : null}
      <Checkbox label="Required" checked={required} onChange={(e) => setRequired(e.target.checked)} />
    </FormDialog>
  );
}

export function NewRowDialog({ table, create, ...props }: Props & { table: Table; create: (values: Record<string, unknown>) => Promise<string | null> }) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const fields = table.fields.filter((f: Field) => EDITABLE.has(f.type));
  return (
    <FormDialog
      {...props}
      onOpenChange={(open) => { if (!open) setDrafts({}); props.onOpenChange(open); }}
      title="New row"
      submitLabel="Add row"
      submit={async () => {
        const values: Record<string, unknown> = {};
        for (const f of fields) {
          const v = valueOf(f, drafts[f.id] ?? draftOf(f, null));
          // An untouched checkbox stays unset, so a required one is not satisfied by accident.
          if (v !== null && !(f.type === "checkbox" && v === false && drafts[f.id] === undefined)) values[f.name] = v;
        }
        const message = await create(values);
        if (message === null) setDrafts({});
        return message;
      }}
    >
      {fields.length === 0 ? <p>This table has no columns yet. Add a column first.</p> : null}
      {fields.map((f) => (
        <div className="ad-field" key={f.id}>
          <label className="ad-field__label" htmlFor={`new-${f.id}`}>{f.name}{f.required ? " (required)" : ""}</label>
          <Editor field={f} id={`new-${f.id}`} draft={drafts[f.id] ?? draftOf(f, null)} onChange={(d) => setDrafts({ ...drafts, [f.id]: d })} />
        </div>
      ))}
    </FormDialog>
  );
}

/** Ask before a delete. `confirm` resolves to an error text, or `null` to close. */
export function ConfirmDialog({ title, description, label, confirm, ...props }: Props & { title: string; description: string; label: string; confirm: () => Promise<string | null> }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      {...props}
      onOpenChange={(next) => { setError(null); props.onOpenChange(next); }}
      title={title}
      description={description}
      footer={
        <>
          <DialogClose asChild><Button variant="ghost">Cancel</Button></DialogClose>
          <Button variant="danger" loading={busy} onClick={async () => { setBusy(true); const m = await confirm(); setBusy(false); setError(m); if (m === null) props.onOpenChange(false); }}>{label}</Button>
        </>
      }
    >
      {error ? <p role="alert" className="form__error">{error}</p> : null}
    </Dialog>
  );
}
