import { describe, expect, it } from "vitest";
import { APP_DESCRIPTION, APP_NAME } from "@/lib/app-config";

describe("app config", () => {
  it("names the app with the template's rename marker", () => {
    expect(APP_NAME).toBe("Bench Web Template");
  });

  it("has a description for page metadata", () => {
    expect(APP_DESCRIPTION.length).toBeGreaterThan(0);
  });
});
