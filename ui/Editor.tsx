import type { Field } from "agentic-tables/client";
import { forwardRef, type KeyboardEventHandler } from "react";
import type { Draft } from "./values";

interface Props {
  field: Field;
  draft: Draft;
  onChange: (draft: Draft) => void;
  /** The accessible name when there is no visible label. */
  label?: string;
  id?: string;
  onKeyDown?: KeyboardEventHandler;
  onBlur?: () => void;
  invalid?: boolean;
}

/** One typed control for one field. A grid cell and the new-row form share it. */
export const Editor = forwardRef<HTMLElement, Props>(function Editor({ field, draft, onChange, label, id, onKeyDown, onBlur, invalid }, ref) {
  const common = { id, "aria-label": label, "aria-invalid": invalid || undefined, onKeyDown, onBlur };
  switch (field.type) {
    case "checkbox":
      return <input {...common} ref={ref as never} type="checkbox" className="ad-checkbox" checked={draft === true} onChange={(e) => onChange(e.target.checked)} />;
    case "single_select":
      return (
        <select {...common} ref={ref as never} className="ad-input" value={String(draft)} onChange={(e) => onChange(e.target.value)}>
          <option value="">(none)</option>
          {field.options?.map((o) => <option key={o}>{o}</option>)}
        </select>
      );
    case "multi_select":
      return (
        <select {...common} ref={ref as never} multiple className="ad-input" value={draft as string[]} onChange={(e) => onChange([...e.target.selectedOptions].map((o) => o.value))}>
          {field.options?.map((o) => <option key={o}>{o}</option>)}
        </select>
      );
    case "long_text":
      return <textarea {...common} ref={ref as never} className="ad-input ad-textarea" rows={3} value={String(draft)} onChange={(e) => onChange(e.target.value)} />;
    default:
      return (
        <input
          {...common}
          ref={ref as never}
          className="ad-input"
          type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"}
          step={field.type === "number" ? "any" : undefined}
          value={String(draft)}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
});
