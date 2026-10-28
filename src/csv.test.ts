// Failure cases for CSV, written before the code.
//
//  1. A quote that never closes.
//  2. A row with more or fewer cells than the header.
//  3. A header that matches no field of the table.
//  4. A cell that does not fit its field (text in a number column, an option
//     that does not exist). The import reports the line and writes no row.
//  5. A quoted cell with a comma, a quote, or a newline survives a round trip.
//  6. A column of mixed numbers and words is text, not a number.
//  7. A column with no values is text.
import { describe, expect, test } from "vitest";
import { createMemoryStore, createTables, ValidationError, type Actor } from "./index.js";
import { csvToValues, inferFields, parseCsv, toCsv } from "./csv.js";

const human: Actor = { id: "u1", kind: "human" };

describe("parseCsv", () => {
  test("rejects an unclosed quote", () => {
    expect(() => parseCsv('a,b\n"x,y\n')).toThrow(/quote/);
  });
  test("reads quotes, commas, newlines, and CRLF", () => {
    expect(parseCsv('a,b\r\n"x, ""y""","line1\nline2"\r\n')).toEqual([["a", "b"], ['x, "y"', "line1\nline2"]]);
  });
});

describe("import", () => {
  async function table() {
    const t = createTables(createMemoryStore());
    const base = await t.createBase("b");
    const people = await t.createTable(base.id, "People", [
      { name: "Name", type: "text", required: true },
      { name: "Age", type: "number" },
      { name: "Stage", type: "single_select", options: ["lead", "won"] },
    ]);
    return { t, people };
  }
  const lines = async (text: string) => {
    const { people } = await table();
    const [header, ...rows] = parseCsv(text);
    try {
      csvToValues(people, header!, rows);
      return [];
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      return (e as ValidationError).issues.map((i) => i.field);
    }
  };
  test("rejects ragged rows and unknown headers", async () => {
    expect(await lines("Name,Age\nAda,1,2\n")).toEqual(["line 2"]);
    expect(await lines("Name,Age\nAda\n")).toEqual(["line 2"]);
    expect(await lines("Name,Nope\nAda,1\n")).toEqual(["Nope"]);
  });
  test("reports the line and field of a bad cell", async () => {
    expect(await lines("Name,Age,Stage\nAda,x,lead\nBob,3,lost\n")).toEqual(["line 2: Age", "line 3: Stage"]);
  });
  test("an import that fails writes no row", async () => {
    const { t, people } = await table();
    const [header, ...rows] = parseCsv("Name,Age\nAda,1\n,2\n");
    const values = csvToValues(people, header!, rows);
    await expect(t.insertRows(people.id, values, human)).rejects.toBeInstanceOf(ValidationError);
    expect((await t.queryRows(people.id)).items).toEqual([]);
  });
  test("export then import keeps the rows", async () => {
    const { t, people } = await table();
    await t.insertRows(people.id, [{ Name: 'A "q", x\ny', Age: 2, Stage: "won" }, { Name: "B" }], human);
    const csv = toCsv(people, (await t.queryRows(people.id)).items);
    const [header, ...rows] = parseCsv(csv);
    expect(csvToValues(people, header!, rows)).toEqual([{ Name: 'A "q", x\ny', Age: 2, Stage: "won" }, { Name: "B" }]);
  });
});

describe("inferFields", () => {
  test("infers types and falls back to text", () => {
    const header = ["n", "mixed", "flag", "day", "empty", "kind"];
    const rows = [
      ["1", "1", "true", "2026-01-01", "", "a"],
      ["2.5", "x", "FALSE", "2026-02-01", "", "b"],
      ["", "3", "true", "", "", "a"],
      ["4", "4", "true", "2026-03-01", "", "b"],
      ["5", "5", "false", "2026-04-01", "", "a"],
      ["6", "6", "true", "2026-05-01", "", "b"],
    ];
    expect(inferFields(header, rows).map((f) => [f.name, f.type])).toEqual([
      ["n", "number"], ["mixed", "text"], ["flag", "checkbox"], ["day", "date"], ["empty", "text"], ["kind", "single_select"],
    ]);
  });
});
