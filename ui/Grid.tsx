import { BotIcon, Button } from "agentic-design/react";
import type { Field, Row, Table } from "agentic-tables/client";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Editor } from "./Editor";
import { draftOf, EDITABLE, show, valueOf, type Draft } from "./values";

interface Props {
  table: Table;
  rows: Row[];
  /** Save one cell. Resolves to an error text, or `null` when it saved. */
  onCommit: (row: Row, field: Field, value: ReturnType<typeof valueOf>) => Promise<string | null>;
  onDelete: (row: Row) => void;
  /** Column menus. They sit in the header, outside the cell grid. */
  header: (field: Field) => React.ReactNode;
}

const machine = (kind: string) => kind !== "human";
/** Who made the last edit, in words. Color is never the only sign. */
export const authorText = (kind: string) => (kind === "human" ? "Person" : kind === "user_token" ? "Person via agent" : "Agent");

export function Grid({ table, rows, onCommit, onDelete, header }: Props) {
  const fields = table.fields;
  const columns = fields.length + 2; // the fields, who edited, and the row action
  const [pos, setPos] = useState({ r: 0, c: 0 });
  const [edit, setEdit] = useState<{ r: number; c: number; draft: Draft } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const cells = useRef(new Map<string, HTMLElement>());
  const editor = useRef<HTMLElement | null>(null);
  const settled = useRef(false);
  const refocus = useRef(false);
  const key = (r: number, c: number) => `${r}:${c}`;

  const r = Math.min(pos.r, Math.max(rows.length - 1, 0));
  const c = Math.min(pos.c, columns - 1);
  useEffect(() => {
    if (edit) editor.current?.focus();
    else if (refocus.current) {
      refocus.current = false;
      cells.current.get(key(r, c))?.focus();
    }
  }, [edit, r, c]);

  const leave = () => {
    refocus.current = true;
    setEdit(null);
  };
  async function commit(fromKey = true) {
    if (!edit || settled.current) return;
    settled.current = true;
    const row = rows[edit.r]!;
    const field = fields[edit.c]!;
    const value = valueOf(field, edit.draft);
    if (JSON.stringify(value) === JSON.stringify(row.values[field.name] ?? null)) return cancel();
    const message = await onCommit(row, field, value);
    if (message === null) {
      setProblem(null);
      leave();
    } else {
      setProblem(message);
      settled.current = false;
      if (fromKey) editor.current?.focus();
    }
  }
  function cancel() {
    settled.current = true;
    setProblem(null);
    leave();
  }
  function begin(row: number, col: number) {
    const field = fields[col];
    if (!field || !EDITABLE.has(field.type)) return;
    const draft = draftOf(field, rows[row]!.values[field.name]);
    if (field.type === "checkbox") {
      void onCommit(rows[row]!, field, !draft);
      return;
    }
    settled.current = false;
    setProblem(null);
    setEdit({ r: row, c: col, draft });
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
      if (col === columns - 1) onDelete(rows[row]!);
      else begin(row, col);
    } else if (e.key === " " && fields[col]?.type === "checkbox") {
      e.preventDefault();
      begin(row, col);
    }
  }
  function onEditorKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    } else if (e.key === "Enter" && !(e.shiftKey && edit && fields[edit.c]?.type === "long_text")) {
      e.preventDefault();
      void commit();
    }
  }

  const cellProps = (row: number, col: number) => ({
    role: "gridcell" as const,
    ref: (el: HTMLElement | null) => void (el ? cells.current.set(key(row, col), el) : cells.current.delete(key(row, col))),
    tabIndex: row === r && col === c ? 0 : -1,
    onFocus: () => setPos({ r: row, c: col }),
    onKeyDown: (e: KeyboardEvent) => onCellKey(e, row, col),
  });

  return (
    <div className="grid-wrap">
      <table role="grid" aria-label={`${table.name} rows`} aria-rowcount={rows.length + 1} className="grid">
        <thead>
          <tr>
            {fields.map((f) => (
              <th key={f.id} scope="col" className="grid__head">
                <span>{f.name}{f.required ? <span className="grid__req" aria-label=" (required)"> *</span> : null}</span>
                <span className="grid__type">{f.type.replace("_", " ")}</span>
                {header(f)}
              </th>
            ))}
            <th scope="col" className="grid__head">Last edit by</th>
            <th scope="col" className="grid__head"><span className="ad-sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={row.id} data-agent={machine(row.updatedBy.kind) || undefined} aria-rowindex={ri + 2}>
              {fields.map((f, ci) => {
                const editing = edit?.r === ri && edit.c === ci;
                return (
                  <td key={f.id} {...cellProps(ri, ci)} className="grid__cell" aria-readonly={!EDITABLE.has(f.type) || undefined}>
                    {editing ? (
                      <>
                        <Editor ref={editor} field={f} draft={edit.draft} label={`${f.name}, row ${ri + 1}`} onChange={(draft) => setEdit({ ...edit, draft })} onKeyDown={onEditorKey} onBlur={() => void commit(false)} invalid={problem !== null} />
                        {problem ? <p role="alert" className="grid__problem">{problem}</p> : null}
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
                {machine(row.updatedBy.kind) ? <span className="ad-pill grid__agent"><BotIcon aria-hidden="true" width={14} height={14} /> {authorText(row.updatedBy.kind)}</span> : authorText(row.updatedBy.kind)}
              </td>
              <td {...cellProps(ri, fields.length + 1)} className="grid__cell">
                <Button size="sm" variant="ghost" tabIndex={-1} aria-label={`Delete row ${ri + 1}`} onClick={() => onDelete(row)}>Delete</Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
