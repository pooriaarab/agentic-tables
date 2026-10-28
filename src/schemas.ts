import { z } from "zod";
import { FIELD_TYPES } from "./model.js";

/** The most rows one batch may write. The MCP tool uses the same cap. */
export const MAX_BATCH_ROWS = 500;
/** The most bytes one request body may hold. */
export const MAX_BODY_BYTES = 1024 * 1024;

const text = z.string().max(10_000);
const name = z.string().trim().min(1).max(200);
const values = z.record(z.unknown());

const fieldInput = z
  .object({
    name,
    type: z.enum(FIELD_TYPES),
    required: z.boolean().optional(),
    options: z.array(text).max(500).optional(),
    linkTable: text.optional(),
  })
  .strict();

const filter = z.record(z.unknown());
const sort = z.object({ field: text, direction: z.enum(["asc", "desc"]).optional() }).strict();

export const schemas = {
  createBase: z.object({ name }).strict(),
  createTable: z.object({ name, fields: z.array(fieldInput).max(200).optional() }).strict(),
  addField: fieldInput.extend({ default: z.unknown().optional() }).strict(),
  renameField: z.object({ name }).strict(),
  changeType: z
    .object({
      to: z.enum(FIELD_TYPES),
      options: z.array(text).max(500).optional(),
      linkTable: text.optional(),
      onFailure: z.enum(["abort", "clear"]).optional(),
      dryRun: z.boolean().optional(),
    })
    .strict(),
  setRequired: z.object({ required: z.boolean(), dryRun: z.boolean().optional() }).strict(),
  insertRows: z
    .object({ values: values.optional(), rows: z.array(values).min(1).max(MAX_BATCH_ROWS).optional() })
    .strict()
    .refine((body) => (body.values === undefined) !== (body.rows === undefined), { message: "send exactly one of values or rows" }),
  updateRow: z.object({ values }).strict(),
  createView: z
    .object({ name, kind: z.enum(["grid", "board"]), filter: filter.optional(), sort: sort.optional(), groupBy: text.optional() })
    .strict(),
};
