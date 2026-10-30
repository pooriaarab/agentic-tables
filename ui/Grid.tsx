import { BotIcon, Button } from "agentic-design/react";
import type { Field, Row, Table } from "agentic-tables/client";
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { Editor } from "./Editor";
import { draftOf, EDITABLE, show, valueOf, type Draft } from "./values";

interface Props {
  readOnly?: boolean;
  table: Table;
  rows: Row[];
  /** Save one cell. Resolves to an error text, or `null` when it saved. */
  onCommit: (row: Row, field: Field, value: ReturnType<typeof valueOf>) => Promise<string | null>;
  /** Rows remain on the server beyond the ones loaded. */
  more: boolean;
  onDelete: (row: Row) => void;
  /** Column menus. They sit in the header, outside the cell grid. */
  header: (field: Field) => React.ReactNode;
}

const machine = (kind: string) => kind !== "human";
/** Who made the last edit, in words. Color is never the only sign. */
export const authorText = (kind: string) => (kind === "human" ? "Person" : kind === "user_token" ? "Person via agent" : "Agent");

export function Grid({ table, rows, more, onCommit, onDelete, header, readOnly = false }: Props) {
  const fields = table.fields;
  const columns = fields.length + 2; // the fields, who edited, and the row action
  const [pos, setPos] = useState({ r: 0, c: 0 });
  // The editor belongs to a row id, so a re-read that moves the row does not move the editor.
  const [edit, setEdit] = useState<{ id: string; c: number; draft: Draft } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const cells = useRef(new Map<string, HTMLElement>());
  const editor = useRef<HTMLElement | null>(null);
  /** The edit that may still save. A save that finishes for an older edit changes nothing. */
  const session = useRef(0);
  const saving = useRef(false);
  /** True while an editor is open. A blur from an editor that is closing must not save. */
  const active = useRef(false);
  const refocus = useRef<{ id: string; c: number } | null>(null);
  const key = (r: number, c: number) => `${r}:${c}`;
  const editRow = edit ? rows.findIndex((x) => x.id === edit.id) : -1;

  const r = Math.min(pos.r, Math.max(rows.length - 1, 0));
  const c = Math.min(pos.c, columns - 1);
  useEffect(() => {
    if (edit) editor.current?.focus();
    else if (refocus.current) {
      const at = rows.findIndex((x) => x.id === refocus.current!.id);
      if (at >= 0) {
        setPos({ r: at, c: refocus.current.c });
        cells.current.get(key(at, refocus.current.c))?.focus();
      }
      refocus.current = null;
    }
  }, [edit, rows]);

  /** Close the editor. Focus goes back to the cell only when a key closed it: a click or a Tab went elsewhere on purpose. */
  const leave = (id: string, col: number, toCell: boolean) => {
    refocus.current = toCell ? { id, c: col } : null;
    active.current = false;
    setEdit(null);
  };
  async function commit(fromKey: boolean) {
    if (readOnly || !edit || saving.current || !active.current) return;
    const mine = session.current;
    const row = rows[editRow]!;
    const field = fields[edit.c]!;
    let value = valueOf(field, edit.draft);
    const was = row.values[field.name] ?? null;
    // A date input holds the day only. Keep the time of a date and time value.
    if (field.type === "date" && typeof value === "string" && typeof was === "string" && was.length > 10) value += was.slice(10);
    if (JSON.stringify(value) === JSON.stringify(was)) return leave(row.id, edit.c, fromKey);
    saving.current = true;
    const message = await onCommit(row, field, value);
    saving.current = false;
    if (session.current !== mine) return;
    if (message === null) {
      setProblem(null);
      // If the person moved on while the save ran, focus stays where they went.
      const here = document.activeElement;
      leave(row.id, edit.c, fromKey && (here === editor.current || here === document.body));
    } else {
      setProblem(message);
      if (fromKey) editor.current?.focus();
    }
  }
  function cancel() {
    if (!edit || saving.current) return;
    session.current++;
    setProblem(null);
    leave(edit.id, edit.c, true);
  }
  async function begin(row: number, col: number) {
    const field = fields[col];
    if (readOnly || !field || !EDITABLE.has(field.type) || saving.current) return;
    const draft = draftOf(field, rows[row]!.values[field.name]);
    if (field.type === "checkbox") {
      saving.current = true;
      await onCommit(rows[row]!, field, !draft);
      saving.current = false;
      return;
    }
    session.current++;
    active.current = true;
    setProblem(null);
    setEdit({ id: rows[row]!.id, c: col, draft });
  }

  function onCellKey(e: KeyboardEvent, row: number, col: number) {
    if (e.target !== e.currentTarget) return;
    const move = (dr: number, dc: number) => {
      e.preventDefault();
      const next = { r: Math.max(0, Math.min(rows.length - 1, row + dr)), c: Math.max(0, Math.min(columns - 1, col + dc)) };
      setPos(next);
      cells.current.get(key(next.r, next.c))?.focus();
    };
    if (e.key === "ArrowDown") move(1, 0);
    else if (e.key === "ArrowUp") move(-1, 0);
    else if (e.key === "ArrowRight") move(0, 1);
    else if (e.key === "ArrowLeft") move(0, -1);
    else if (e.key === "Home") move(0, -col);
    else if (e.key === "End") move(0, columns - 1 - col);
    else if (e.key === "Enter" || e.key === "F2") {
      e.preventDefault();
      if (col === columns - 1 && !readOnly) onDelete(rows[row]!);
      else void begin(row, col);
    } else if (e.key === " " && fields[col]?.type === "checkbox") {
      e.preventDefault();
      void begin(row, col);
    }
  }
  function onEditorKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    } else if (e.key === "Enter" && !(e.shiftKey && edit && fields[edit.c]?.type === "long_text")) {
      e.preventDefault();
      void commit(true);
    }
  }

  /** A click inside an open editor belongs to the editor. */
  const inEditor = (e: MouseEvent) => (e.target as HTMLElement).closest("input, select, textarea") !== null;

  const cellProps = (row: number, col: number) => ({
    role: "gridcell" as const,
    ref: (el: HTMLElement | null) => void (el ? cells.current.set(key(row, col), el) : cells.current.delete(key(row, col))),
    tabIndex: row === r && col === c ? 0 : -1,
    onFocus: () => setPos({ r: row, c: col }),
    onKeyDown: (e: KeyboardEvent) => onCellKey(e, row, col),
    // A pointer reaches the editor too: a click toggles a checkbox and a double click edits.
    onClick: fields[col]?.type === "checkbox" ? (e: MouseEvent) => !inEditor(e) && void begin(row, col) : undefined,
    onDoubleClick: (e: MouseEvent) => !inEditor(e) && void begin(row, col),
  });

  return (
    <div className="grid-wrap">
      <table role="grid" aria-label={`${table.name} rows`} aria-rowcount={more ? -1 : rows.length + 1} className="grid">
        <thead>
          <tr>
            {fields.map((f) => (
              <th key={f.id} scope="col" className="grid__head">
                <span>{f.name}{f.required ? <><span className="grid__req" aria-hidden="true"> *</span><span className="agd-sr-only"> (required)</span></> : null}</span>
                <span className="grid__type">{f.type.replace("_", " ")}</span>
                {header(f)}
              </th>
            ))}
            <th scope="col" className="grid__head">Last edit by</th>
            <th scope="col" className="grid__head"><span className="agd-sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={row.id} data-agent={machine(row.updatedBy.kind) || undefined} aria-rowindex={ri + 2}>
              {fields.map((f, ci) => {
                const editing = editRow === ri && edit?.c === ci;
                return (
                  <td key={f.id} {...cellProps(ri, ci)} className="grid__cell" aria-readonly={readOnly || !EDITABLE.has(f.type) || undefined}>
                    {editing ? (
                      <>
                        <Editor ref={editor} field={f} draft={edit.draft} label={`${f.name}, row ${ri + 1}`} onChange={(draft) => setEdit({ ...edit, draft })} onKeyDown={onEditorKey} onBlur={() => void commit(false)} invalid={problem !== null} describedBy={problem ? "grid-problem" : undefined} />
                        {problem ? <p role="alert" id="grid-problem" className="grid__problem">{problem}</p> : null}
                      </>
                    ) : f.type === "checkbox" ? (
                      <span>{row.values[f.name] === true ? "✓ Yes" : "No"}</span>
                    ) : (
                      show(f, row.values[f.name])
                    )}
                  </td>
                );
              })}
              <td {...cellProps(ri, fields.length)} className="grid__cell">
                {machine(row.updatedBy.kind) ? <span className="agd-pill grid__agent"><BotIcon aria-hidden="true" width={14} height={14} /> {authorText(row.updatedBy.kind)}</span> : authorText(row.updatedBy.kind)}
              </td>
              <td {...cellProps(ri, fields.length + 1)} className="grid__cell">
                <Button disabled={readOnly} size="sm" variant="ghost" tabIndex={-1} aria-label={`Delete row ${ri + 1}`} onClick={() => onDelete(row)}>Delete</Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
