import AxeBuilder from "@axe-core/playwright";
import { createClient } from "../src/client.js";
import { expect, test, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const SHOTS = "docs/screenshots";
const THEMES = ["light", "dark"] as const;

/** Check the page against WCAG 2.2 AA in both themes, and keep a screenshot of each. */
async function audit(page: Page, name: string) {
  for (const theme of THEMES) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
    const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`), `${name} (${theme})`).toEqual([]);
    await page.screenshot({ path: `${SHOTS}/${name}-${theme}.png`, fullPage: true });
  }
  await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));
}

test("empty state, then create a table", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "No tables yet" })).toBeVisible();
  await audit(page, "1-empty");

  await page.getByRole("button", { name: "New table" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New table" });
  await audit(page, "2-dialog");
  await dialog.getByLabel("Table name").fill("Tasks");
  await dialog.getByRole("button", { name: "Create table" }).click();
  await expect(page.getByRole("heading", { name: "Tasks", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No columns yet" })).toBeVisible();
});

test("add columns and a row, edit by keyboard, reload keeps it", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Tasks" }).click();
  for (const [name, type, options] of [["Title", "text", ""], ["Done", "checkbox", ""], ["Points", "number", ""], ["Status", "single_select", "todo, doing, done"]]) {
    await page.getByRole("button", { name: "Add column" }).first().click();
    const dialog = page.getByRole("dialog", { name: "New column" });
    await dialog.getByLabel("Column name").fill(name!);
    await dialog.getByLabel("Type").selectOption(type!);
    if (options) await dialog.getByLabel("Options").fill(options);
    await dialog.getByRole("button", { name: "Add column" }).click();
    await expect(page.getByRole("columnheader", { name: new RegExp(name!) })).toBeVisible();
  }
  await expect(page.getByRole("heading", { name: "No rows yet" })).toBeVisible();
  await audit(page, "3-no-rows");

  await page.getByRole("button", { name: "Add row" }).first().click();
  const form = page.getByRole("dialog", { name: "New row" });
  await form.getByLabel("Title").fill("Write the docs");
  await form.getByLabel("Points").fill("3");
  await form.getByLabel("Status").selectOption("todo");
  await form.getByRole("button", { name: "Add row" }).click();
  const grid = page.getByRole("grid", { name: "Tasks rows" });
  await expect(grid.getByRole("gridcell", { name: "Write the docs" })).toBeVisible();

  // Keyboard: focus the first cell, move right and down, Enter to edit, Escape to cancel, Enter to save.
  await grid.getByRole("gridcell", { name: "Write the docs" }).focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  const points = page.getByLabel("Points, row 1");
  await expect(points).toBeFocused();
  await points.fill("99");
  await page.keyboard.press("Escape");
  await expect(grid.getByRole("gridcell", { name: "3", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await page.getByLabel("Points, row 1").fill("5");
  await page.keyboard.press("Enter");
  await expect(grid.getByRole("gridcell", { name: "5", exact: true })).toBeFocused();

  // A checkbox toggles with Enter.
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Enter");
  await expect(grid.getByRole("gridcell", { name: "✓ Yes" })).toBeVisible();

  await page.reload();
  await page.getByRole("link", { name: "Tasks" }).click();
  await expect(page.getByRole("gridcell", { name: "5", exact: true })).toBeVisible();
  await expect(page.getByRole("gridcell", { name: "✓ Yes" })).toBeVisible();
  await audit(page, "4-grid");
});

test("a refused value shows the issue and keeps the cell", async ({ page, baseURL }) => {
  const id = await tableId(page);
  const human = createClient({ baseUrl: baseURL!, principal: { id: "local-user", kind: "human" } });
  await human.setRequired(id, (await human.getTable(id)).fields.find((f) => f.name === "Title")!.id, true);
  await page.goto("/#/t/" + id);
  await page.getByRole("gridcell", { name: "Write the docs" }).focus();
  await page.keyboard.press("Enter");
  await page.getByLabel("Title, row 1").fill("");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert")).toContainText("Title");
  await expect(page.getByLabel("Title, row 1")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("gridcell", { name: "Write the docs" })).toBeFocused();
});

test("an agent's row carries a marker", async ({ page, baseURL }) => {
  const human = createClient({ baseUrl: baseURL!, principal: { id: "local-user", kind: "human" } });
  const agent = createClient({ baseUrl: baseURL!, principal: { id: "helper", kind: "agent" } });
  const id = await tableId(page);
  await human.shareTable(id, { kind: "agent", id: "helper" }, "editor");
  await agent.insertRow(id, { Title: "Written by an agent", Points: 1 });
  await page.goto("/#/t/" + id);
  const row = page.getByRole("row", { name: /Written by an agent/ });
  await expect(row.getByText("Agent", { exact: true })).toBeVisible();
  await expect(page.getByRole("row", { name: /Write the docs/ }).getByText("Person", { exact: true })).toBeVisible();
  await audit(page, "5-agent-row");
});

test("focus stays where the person put it", async ({ page }) => {
  await page.goto("/#/t/" + (await tableId(page)));
  const cell = page.getByRole("gridcell", { name: "Write the docs" });

  // Tab out of an open editor goes on to the next control. It does not bounce back into the grid.
  await cell.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Title, row 1")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator("td:focus")).toHaveCount(0);
  await expect(page.getByLabel("Title, row 1")).toHaveCount(0);

  // A double click opens the editor for a pointer user.
  await cell.dblclick();
  await expect(page.getByLabel("Title, row 1")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(cell).toBeFocused();

  // A sort control keeps focus after it changes the rows, so arrow keys step through its options.
  const sort = page.getByLabel("Sort by");
  await sort.focus();
  await sort.selectOption({ label: "Title" });
  await expect(sort).toBeFocused();
  await sort.selectOption("");
  await expect(sort).toBeFocused();
});

test("filter, sort, delete a row and a column", async ({ page }) => {
  await page.goto("/#/t/" + (await tableId(page)));
  await page.getByLabel("Filter column").selectOption({ label: "Title" });
  await page.getByLabel("Value").fill("agent");
  await page.getByRole("button", { name: "Apply filter" }).click();
  await expect(page.getByRole("gridcell", { name: "Write the docs" })).toHaveCount(0);
  await expect(page.getByRole("gridcell", { name: "Written by an agent" })).toBeVisible();
  await page.getByLabel("Value").fill("zzz");
  await page.getByRole("button", { name: "Apply filter" }).click();
  await expect(page.getByRole("heading", { name: "No rows match" })).toBeVisible();
  await page.getByRole("button", { name: "Clear filter" }).click();

  // A checkbox filter shows Yes and sends Yes.
  await page.getByLabel("Filter column").selectOption({ label: "Done" });
  await expect(page.getByLabel("Value")).toHaveValue("true");
  await page.getByRole("button", { name: "Apply filter" }).click();
  await expect(page.getByRole("gridcell", { name: "Written by an agent" })).toHaveCount(0);
  await expect(page.getByRole("gridcell", { name: "Write the docs" })).toBeVisible();
  await page.getByRole("button", { name: "Clear filter" }).click();

  await page.getByLabel("Sort by").selectOption({ label: "Points" });
  await page.getByLabel("Direction").selectOption("desc");
  await expect(page.getByRole("row").nth(1)).toContainText("Write the docs");

  await page.getByRole("button", { name: "Delete row 1" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete row" }).click();
  await expect(page.getByRole("gridcell", { name: "Write the docs" })).toHaveCount(0);
  // Focus does not fall to the page body after a delete.
  await expect(page.locator("#table-title")).toBeFocused();

  await page.getByRole("button", { name: "Column options for Done" }).click();
  await page.getByRole("menuitem", { name: "Delete column" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete column" }).click();
  await expect(page.getByRole("columnheader", { name: /Done/ })).toHaveCount(0);

  // Delete the column the table is sorted on. The view stays, with the sort cleared.
  await page.getByRole("button", { name: "Column options for Points" }).click();
  await page.getByRole("menuitem", { name: "Delete column" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete column" }).click();
  await expect(page.getByRole("columnheader", { name: /Points/ })).toHaveCount(0);
  await expect(page.getByLabel("Sort by")).toHaveValue("");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("grid", { name: "Tasks rows" })).toBeVisible();

  // Delete a column that is only picked in the filter control, not applied. The view reads again.
  await page.getByLabel("Filter column").selectOption({ label: "Status" });
  await page.getByRole("button", { name: "Column options for Status" }).click();
  await page.getByRole("menuitem", { name: "Delete column" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete column" }).click();
  await expect(page.getByRole("columnheader", { name: /Status/ })).toHaveCount(0);
  await expect(page.getByLabel("Filter column").locator("option", { hasText: "Status" })).toHaveCount(0);
});

test("a failed load shows an error with a retry", async ({ page }) => {
  await page.route("**/api/v1/tables/bases", (route) => route.abort());
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("did not answer");
  await audit(page, "6-error");
  await page.unroute("**/api/v1/tables/bases");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("link", { name: "Tasks" })).toBeVisible();
});

async function tableId(page: Page): Promise<string> {
  await page.goto("/");
  const href = await page.getByRole("link", { name: "Tasks" }).getAttribute("href");
  return href!.replace("#/t/", "");
}
