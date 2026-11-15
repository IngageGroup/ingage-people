import { expect, test } from "@playwright/test";
import { APP_NAME } from "@/lib/app-config";

test.describe("App shell", () => {
  test("renders inside the app shell", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(APP_NAME);
    await expect(page.getByRole("banner")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Ask a Question" })).toBeVisible();
  });

  test("shows the app name in the header on desktop", async ({ page, isMobile }) => {
    test.skip(isMobile, "AppHeader hides the app name on narrow screens");
    await page.goto("/");
    await expect(page.getByRole("banner").getByText(APP_NAME)).toBeVisible();
  });

  test("has a sign out button in the header", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("banner").getByRole("button", { name: "Sign out" })).toBeVisible();
  });
});
