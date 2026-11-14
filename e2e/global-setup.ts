import { chromium, type FullConfig } from "@playwright/test";

const WARM_PATHS = ["/", "/notes", "/auth/signin"];

/**
 * `next dev` compiles each route on first request and reloads open pages while it
 * does, which flakes whichever test touches a route first. Visit each route once.
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) throw new Error("playwright.config.ts must set use.baseURL");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ baseURL });
    for (const path of WARM_PATHS) {
      await page.goto(path, { waitUntil: "networkidle" });
    }
    await page.request.get("/api/health");
  } finally {
    await browser.close();
  }
}
