import { csvToValues, inferFields, parseCsv } from "./csv.js";
import type { Context } from "./context.js";
import { NotFoundError, TablesError, type Table } from "./model.js";

/**
 * Insert the rows of a CSV text into a table. Every cell is checked first, so one bad cell writes no row.
 * With `create`, a missing table is made with a type guessed for each column. It stays if a cell then fails.
 * `maxRows` refuses a larger file before it writes anything.
 */
export async function importCsv(ctx: Context, name: string, text: string, create: boolean, maxRows = Infinity): Promise<{ inserted: number; table: Table }> {
  const [header, ...records] = parseCsv(text);
  if (!header) throw new TablesError("CSV_INVALID", "the CSV is empty");
  if (records.length > maxRows) throw new TablesError("PAYLOAD_TOO_LARGE", `the CSV has ${records.length} rows: import at most ${maxRows} at a time`);
  let table = await ctx.table(name).catch((error: unknown) => {
    if (!create || !(error instanceof NotFoundError)) throw error;
    return undefined;
  });
  table ??= await ctx.tables.createTable(await ctx.baseId(), name, inferFields(header, records));
  const rows = await ctx.tables.insertRows(table.id, csvToValues(table, header, records));
  return { inserted: rows.length, table };
}
