// Failure cases, written before the code. Each one must fail loudly and leave
// the stored data as it was.
//
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
// 10. Delete a row that other rows link to: the links go away.
// 11. Duplicate field names when a table is created.
import { beforeEach, describe, expect, test } from "vitest";
import {
  createMemoryStore,
  createTables,
  NotFoundError,
  ValidationError,
  type Actor,
  type Tables,
} from "./index.js";

const human: Actor = { id: "u1", kind: "human" };
const agent: Actor = { id: "a1", kind: "agent_of_human" };

let t: Tables;
let baseId: string;

beforeEach(async () => {
  t = createTables(createMemoryStore());
  baseId = (await t.createBase("Crm")).id;
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

describe("links and tables", () => {
  test("deleting a row removes it from links in other rows", async () => {
    const { table, companies } = await people();
    const company = await t.insertRow(companies.id, { Name: "Acme" }, human);
    const keep = await t.insertRow(companies.id, { Name: "Keep" }, human);
    const row = await t.insertRow(table.id, { Name: "x", Company: [company.id, keep.id] }, human);
    await t.deleteRow(company.id);
    expect((await t.getRow(row.id)).values.Company).toEqual([keep.id]);
    await expect(t.getRow(company.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  test("a table with duplicate field names is refused", async () => {
    await expectIssue(
      t.createTable(baseId, "Dup", [{ name: "A", type: "text" }, { name: "a", type: "number" }]),
      "a",
      "duplicate_field",
    );
  });
});
