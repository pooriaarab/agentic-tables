// Failure cases, written before the code. Each one must fail loudly and leave
// the stored data as it was.
//
// Validation
//  1. A value of the wrong type for its field (text, number, checkbox, date,
//     multi select that is not an array, link that is not an array).
//  2. A number that is NaN or Infinity.
//  3. A key that matches no field.
//  4. A required field that is missing on insert, or set to null on update.
//  5. A select value that is not an option, or a duplicate multi select value.
//  6. A link to a row that does not exist, or that is in another table.
//  7. A file ref without a key.
//  8. An update of a row that does not exist.
//  9. An insert that fails one field writes no row.
// Migrations
// 10. Change type with values that do not convert: abort, change nothing,
//     list the rows. A dry run reports the same and writes nothing.
// 11. Change type with the "clear" policy: bad values become empty, listed.
// 12. Change to a select with options that miss a stored value.
// 13. Delete a row that other rows link to: the links go away.
// 14. Remove a select option that rows still use: abort, or clear on request.
// 15. Add a required field to a table with rows: reject without a default.
// 16. Rename a field to a name that exists (any case), or a field that is gone.
// 17. Delete a field: values go, later writes to that name fail.
// 18. Duplicate field names when a table is created.
// 20. Select to select without options keeps the current options, and a given
//     list reports the options it drops.
// 21. Text to number refuses "007", "0x1A", "1e3", "-0", "Infinity", "NaN",
//     and numbers past the safe range. "2.50" and "-3" convert.
// 22. Clear on a required field is refused, for a type change and for options.
// 23. Point a link at another table: refused.
// 24. Number or checkbox to select converts. Blank text cells count as empty.
// 19. A required field set to "" or [] (the same emptiness rule as the query layer).
// 25. A list call with extra options reads only the rows of its own table.
// 26. Field names that differ only by surrounding spaces are duplicates.
import { beforeEach, describe, expect, test } from "vitest";
import { createMemoryStore } from "agentic-identity";
import {
  createTables,
  MigrationError,
  NotFoundError,
  ValidationError,
  type Actor,
  type ListRowsOptions,
  type Tables,
} from "./index.js";

const human: Actor = { id: "u1", kind: "human" };
const agent: Actor = { id: "a1", kind: "agent_of_human" };

let t: Tables;
let baseId: string;

beforeEach(async () => {
  t = createTables(createMemoryStore());
  baseId = (await t.createBase("Crm", human)).id;
});

async function people() {
  const companies = await t.createTable(baseId, "Companies", [{ name: "Name", type: "text", required: true }]);
  const table = await t.createTable(baseId, "People", [
    { name: "Name", type: "text", required: true },
    { name: "Age", type: "number" },
    { name: "Active", type: "checkbox" },
    { name: "Born", type: "date" },
    { name: "Notes", type: "long_text" },
    { name: "Stage", type: "single_select", options: ["lead", "won"] },
    { name: "Tags", type: "multi_select", options: ["a", "b"] },
    { name: "Company", type: "link", linkTable: companies.id },
    { name: "Docs", type: "file" },
  ]);
  return { companies, table };
}

async function expectIssue(promise: Promise<unknown>, field: string, code: string) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ValidationError);
  expect((error as ValidationError).issues).toContainEqual(expect.objectContaining({ field, code }));
}

describe("row validation", () => {
  test("rejects a wrong type for each field type", async () => {
    const { table } = await people();
    const bad = async (values: Record<string, unknown>, field: string) =>
      expectIssue(t.insertRow(table.id, { Name: "x", ...values } as never, human), field, "type");
    await bad({ Name: 5 }, "Name");
    await bad({ Age: "abc" }, "Age");
    await bad({ Active: "yes" }, "Active");
    await bad({ Born: "2020-13-45" }, "Born");
    await bad({ Notes: 1 }, "Notes");
    await bad({ Tags: "a" }, "Tags");
    await bad({ Company: "row_1" }, "Company");
  });

  test("rejects NaN and Infinity", async () => {
    const { table } = await people();
    await expectIssue(t.insertRow(table.id, { Name: "x", Age: Number.NaN }, human), "Age", "type");
    await expectIssue(t.insertRow(table.id, { Name: "x", Age: Infinity }, human), "Age", "type");
  });

  test("rejects an unknown key", async () => {
    const { table } = await people();
    await expectIssue(t.insertRow(table.id, { Name: "x", Nope: 1 }, human), "Nope", "unknown_field");
  });

  test("enforces required on insert and on update", async () => {
    const { table } = await people();
    await expectIssue(t.insertRow(table.id, { Age: 3 }, human), "Name", "required");
    const row = await t.insertRow(table.id, { Name: "Ada" }, human);
    await expectIssue(t.updateRow(row.id, { Name: null }, human), "Name", "required");
    expect((await t.getRow(row.id)).values.Name).toBe("Ada");
  });

  test("treats an empty string and an empty list as empty for required", async () => {
    const { table } = await people();
    await expectIssue(t.insertRow(table.id, { Name: "" }, human), "Name", "required");
    const row = await t.insertRow(table.id, { Name: "Ada" }, human);
    await expectIssue(t.updateRow(row.id, { Name: "" }, human), "Name", "required");
    const tagged = await t.createTable(baseId, "Tagged", [{ name: "Tags", type: "multi_select", options: ["a"], required: true }]);
    await expectIssue(t.insertRow(tagged.id, { Tags: [] }, human), "Tags", "required");
    expect((await t.insertRow(tagged.id, { Tags: ["a"] }, human)).values.Tags).toEqual(["a"]);
  });

  test("rejects select values that are not options and duplicates", async () => {
    const { table } = await people();
    await expectIssue(t.insertRow(table.id, { Name: "x", Stage: "lost" }, human), "Stage", "option");
    await expectIssue(t.insertRow(table.id, { Name: "x", Tags: ["a", "z"] }, human), "Tags", "option");
    await expectIssue(t.insertRow(table.id, { Name: "x", Tags: ["a", "a"] }, human), "Tags", "duplicate");
  });

  test("rejects links to missing rows and to rows of another table", async () => {
    const { table, companies } = await people();
    await expectIssue(t.insertRow(table.id, { Name: "x", Company: ["row_missing"] }, human), "Company", "link_missing");
    const other = await t.insertRow(table.id, { Name: "y" }, human);
    await expectIssue(t.insertRow(table.id, { Name: "x", Company: [other.id] }, human), "Company", "link_missing");
    const company = await t.insertRow(companies.id, { Name: "Acme" }, human);
    const row = await t.insertRow(table.id, { Name: "x", Company: [company.id] }, human);
    expect(row.values.Company).toEqual([company.id]);
  });

  test("rejects a file ref without a key", async () => {
    const { table } = await people();
    await expectIssue(t.insertRow(table.id, { Name: "x", Docs: [{ name: "a.pdf" }] }, human), "Docs", "type");
    const row = await t.insertRow(table.id, { Name: "x", Docs: [{ key: "k1", name: "a.pdf" }] }, human);
    expect(row.values.Docs).toEqual([{ key: "k1", name: "a.pdf" }]);
  });

  test("rejects an update of a missing row", async () => {
    await expect(t.updateRow("row_missing", { Name: "x" }, human)).rejects.toBeInstanceOf(NotFoundError);
  });

  test("a failed insert writes no row", async () => {
    const { table } = await people();
    await t.insertRow(table.id, { Name: "x", Stage: "lost" }, human).catch(() => undefined);
    expect((await t.listRows(table.id)).items).toEqual([]);
  });

  test("keeps the principal kind on create and update", async () => {
    const { table } = await people();
    const row = await t.insertRow(table.id, { Name: "x" }, human);
    const updated = await t.updateRow(row.id, { Age: 4 }, agent);
    expect(updated.createdBy).toEqual(human);
    expect(updated.updatedBy).toEqual(agent);
  });
});

describe("schema migrations", () => {
  async function withNotes(notes: string[]) {
    const table = await t.createTable(baseId, "Notes", [{ name: "Name", type: "text" }, { name: "Val", type: "text" }]);
    for (const [i, Val] of notes.entries()) await t.insertRow(table.id, { Name: `n${i}`, Val }, human);
    return table;
  }
  const vals = async (id: string) => (await t.listRows(id)).items.map((r) => r.values.Val);

  test("change type aborts on bad values and changes nothing", async () => {
    const table = await withNotes(["1", "two", "3", "four"]);
    const error = await t.changeFieldType(table.id, "Val", { to: "number" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MigrationError);
    const report = (error as MigrationError).report;
    expect(report.failures.map((f) => f.value)).toEqual(["two", "four"]);
    expect(report.applied).toBe(false);
    expect(await vals(table.id)).toEqual(["1", "two", "3", "four"]);
    expect((await t.getTable(table.id)).fields[1]?.type).toBe("text");
  });

  test("a dry run reports and writes nothing", async () => {
    const table = await withNotes(["1", "two"]);
    const report = await t.changeFieldType(table.id, "Val", { to: "number", dryRun: true });
    expect(report).toMatchObject({ total: 2, converted: 1, applied: false });
    expect(report.failures).toHaveLength(1);
    expect(await vals(table.id)).toEqual(["1", "two"]);
  });

  test("change type converts clean values", async () => {
    const table = await withNotes(["1", " 2.5 "]);
    const report = await t.changeFieldType(table.id, "Val", { to: "number" });
    expect(report.applied).toBe(true);
    expect(await vals(table.id)).toEqual([1, 2.5]);
  });

  test("the clear policy empties bad values and lists them", async () => {
    const table = await withNotes(["1", "two"]);
    const report = await t.changeFieldType(table.id, "Val", { to: "number", onFailure: "clear" });
    expect(report).toMatchObject({ applied: true, converted: 1 });
    expect(report.failures).toHaveLength(1);
    expect(await vals(table.id)).toEqual([1, null]);
  });

  test("select options default to the stored values; given options must cover them", async () => {
    const table = await withNotes(["a", "b", "a"]);
    await expect(t.changeFieldType(table.id, "Val", { to: "single_select", options: ["a"] })).rejects.toBeInstanceOf(
      MigrationError,
    );
    await t.changeFieldType(table.id, "Val", { to: "single_select" });
    expect((await t.getTable(table.id)).fields[1]?.options).toEqual(["a", "b"]);
  });

  test("select to select keeps the current options and reports the ones it drops", async () => {
    const table = await t.createTable(baseId, "S", [{ name: "Stage", type: "single_select", options: ["lead", "won", "lost"] }]);
    await t.insertRow(table.id, { Stage: "lead" }, human);
    const kept = await t.changeFieldType(table.id, "Stage", { to: "multi_select" });
    expect(kept.droppedOptions).toEqual([]);
    expect((await t.getTable(table.id)).fields[0]?.options).toEqual(["lead", "won", "lost"]);
    const dry = await t.changeFieldType(table.id, "Stage", { to: "multi_select", options: ["lead", "won"], dryRun: true });
    expect(dry).toMatchObject({ applied: false, droppedOptions: ["lost"] });
    const shrunk = await t.setOptions(table.id, "Stage", ["lead"]);
    expect(shrunk.droppedOptions).toEqual(["won", "lost"]);
  });

  test("text to number refuses text a number cannot keep exactly", async () => {
    const lossy = ["007", "0x1A", "1e3", "-0", "Infinity", "NaN", "12345678901234567890", "+5", "1,5"];
    const table = await withNotes([...lossy, "2.50", "-3", ""]);
    const dry = await t.changeFieldType(table.id, "Val", { to: "number", dryRun: true });
    expect(dry.failures.map((f) => f.value)).toEqual(lossy);
    expect(dry).toMatchObject({ converted: 2, empty: 1 });
    await expect(t.changeFieldType(table.id, "Val", { to: "number" })).rejects.toBeInstanceOf(MigrationError);
    expect((await vals(table.id)).slice(0, 2)).toEqual(["007", "0x1A"]);
    await t.changeFieldType(table.id, "Val", { to: "number", onFailure: "clear" });
    expect((await vals(table.id)).slice(-3)).toEqual([2.5, -3, null]);
  });

  test("clear is refused on a required field", async () => {
    const table = await t.createTable(baseId, "R", [{ name: "Val", type: "text", required: true }, { name: "Stage", type: "single_select", options: ["a", "b"], required: true }]);
    const row = await t.insertRow(table.id, { Val: "x", Stage: "a" }, human);
    await expectIssue(t.changeFieldType(table.id, "Val", { to: "number", onFailure: "clear" }), "Val", "required");
    await expectIssue(t.setOptions(table.id, "Stage", ["b"], { onInUse: "clear" }), "Stage", "required");
    expect((await t.getRow(row.id)).values).toMatchObject({ Val: "x", Stage: "a" });
  });

  test("a link cannot move to another table", async () => {
    const { table, companies } = await people();
    const other = await t.createTable(baseId, "Orgs", [{ name: "Name", type: "text" }]);
    const company = await t.insertRow(companies.id, { Name: "Acme" }, human);
    const row = await t.insertRow(table.id, { Name: "x", Company: [company.id] }, human);
    await expectIssue(t.changeFieldType(table.id, "Company", { to: "link", linkTable: other.id }), "Company", "type");
    expect((await t.getRow(row.id)).values.Company).toEqual([company.id]);
  });

  test("number and checkbox convert to select", async () => {
    const table = await t.createTable(baseId, "N", [{ name: "Val", type: "number" }]);
    await t.insertRow(table.id, { Val: 3 }, human);
    await t.changeFieldType(table.id, "Val", { to: "single_select" });
    expect((await t.listRows(table.id)).items[0]?.values.Val).toBe("3");
  });

  test("deleting a row removes it from links in other rows", async () => {
    const { table, companies } = await people();
    const company = await t.insertRow(companies.id, { Name: "Acme" }, human);
    const keep = await t.insertRow(companies.id, { Name: "Keep" }, human);
    const row = await t.insertRow(table.id, { Name: "x", Company: [company.id, keep.id] }, human);
    await t.deleteRow(company.id);
    expect((await t.getRow(row.id)).values.Company).toEqual([keep.id]);
    await expect(t.getRow(company.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  test("removing a used option aborts, or clears on request", async () => {
    const { table } = await people();
    const a = await t.insertRow(table.id, { Name: "a", Stage: "lead", Tags: ["a", "b"] }, human);
    await expect(t.setOptions(table.id, "Stage", ["won"])).rejects.toBeInstanceOf(MigrationError);
    expect((await t.getRow(a.id)).values.Stage).toBe("lead");
    await t.setOptions(table.id, "Stage", ["won"], { onInUse: "clear" });
    await t.setOptions(table.id, "Tags", ["b"], { onInUse: "clear" });
    const after = await t.getRow(a.id);
    expect(after.values.Stage).toBeNull();
    expect(after.values.Tags).toEqual(["b"]);
  });

  test("a required field needs a default when rows exist", async () => {
    const table = await withNotes(["x"]);
    await expectIssue(t.addField(table.id, { name: "Owner", type: "text", required: true }), "Owner", "required");
    await t.addField(table.id, { name: "Owner", type: "text", required: true, default: "nobody" });
    expect((await t.listRows(table.id)).items[0]?.values.Owner).toBe("nobody");
    const empty = await t.createTable(baseId, "Empty", [{ name: "Name", type: "text" }]);
    await t.addField(empty.id, { name: "Owner", type: "text", required: true });
  });

  test("rename keeps values and rejects duplicates and missing fields", async () => {
    const table = await withNotes(["x"]);
    await expectIssue(t.renameField(table.id, "Val", "name"), "name", "duplicate_field");
    await expect(t.renameField(table.id, "Gone", "Other")).rejects.toBeInstanceOf(NotFoundError);
    await t.renameField(table.id, "Val", "Value");
    expect((await t.listRows(table.id)).items[0]?.values.Value).toBe("x");
  });

  test("delete a field drops its values and later writes fail", async () => {
    const table = await withNotes(["x"]);
    await t.deleteField(table.id, "Val");
    expect((await t.listRows(table.id)).items[0]?.values).toEqual({ Name: "n0" });
    await expectIssue(t.insertRow(table.id, { Name: "y", Val: "z" }, human), "Val", "unknown_field");
  });

  test("a table with duplicate field names is refused", async () => {
    await expectIssue(
      t.createTable(baseId, "Dup", [{ name: "A", type: "text" }, { name: "a", type: "number" }]),
      "a",
      "duplicate_field",
    );
  });

  test("field names that differ only by surrounding spaces are duplicates", async () => {
    await expectIssue(
      t.createTable(baseId, "Spaced", [{ name: "A", type: "text" }, { name: " a ", type: "number" }]),
      " a ",
      "duplicate_field",
    );
    const table = await t.createTable(baseId, "Solo", [{ name: "A", type: "text" }]);
    await expectIssue(t.addField(table.id, { name: " a", type: "text" }), " a", "duplicate_field");
  });

  test("a list call with extra options reads only its own table", async () => {
    const pets = await t.createTable(baseId, "Pets", [{ name: "Kind", type: "text" }]);
    await t.insertRow(pets.id, { Kind: "cat" }, human);
    const owners = await t.createTable(baseId, "Owners", [{ name: "Name", type: "text" }]);
    await t.insertRow(owners.id, { Name: "Ada" }, human);
    const page = await t.listRows(owners.id, { where: { tableId: pets.id } } as unknown as ListRowsOptions);
    expect(page.items.map((r) => r.values)).toEqual([{ Name: "Ada" }]);
  });
});
