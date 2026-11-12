import { expect, test } from "@playwright/test";
import { APP_NAME } from "@/lib/app-config";

test.describe("Sign-in page", () => {
  test("renders the app name and an enabled Microsoft sign-in button", async ({ page }) => {
    await page.goto("/auth/signin");
    await expect(page.getByRole("heading", { name: APP_NAME })).toBeVisible();
    const button = page.getByRole("button", { name: "Sign in with Microsoft" });
    await expect(button).toBeVisible();
    await expect(button).toBeEnabled();
  });
});
