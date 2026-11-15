import { expect, test } from "@playwright/test";
import { resetNotes } from "./db";

test.describe("Notes sample", () => {
  test.beforeEach(async () => {
    await resetNotes();
  });

  test("shows the empty state when there are no notes", async ({ page }) => {
    await page.goto("/notes");
    await expect(page.getByText("No notes yet")).toBeVisible();
  });

  test("adds a note owned by the signed-in user", async ({ page }) => {
    await page.goto("/notes");
    await page.getByLabel("Title").fill("Buy milk");
    await page.getByRole("button", { name: "Add Note" }).click();
    await expect(page.getByText("Buy milk")).toBeVisible();
    await expect(page.getByText("e2e@example.com")).toBeVisible();
    await expect(page.getByText("No notes yet")).toBeHidden();
    await expect(page.getByLabel("Title")).toHaveValue("");
  });

  test("shows a validation error for an empty title", async ({ page }) => {
    await page.goto("/notes");
    await expect(page.getByText("No notes yet")).toBeVisible();
    await page.getByRole("button", { name: "Add Note" }).click();
    await expect(page.getByText("Title is required")).toBeVisible();
    await expect(page.getByText("No notes yet")).toBeVisible();
  });

  test("shows an error, not the empty state, when notes fail to load", async ({ page }) => {
    await page.route("**/api/notes", (route) =>
      route.request().method() === "GET"
        ? route.fulfill({ status: 500, contentType: "application/json", body: "{}" })
        : route.continue(),
    );
    await page.goto("/notes");
    await expect(page.getByText("Could not load notes.")).toBeVisible();
    await expect(page.getByText("No notes yet")).toBeHidden();
  });
});
