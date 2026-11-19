import { describe, expect, it } from "vitest";
import { M365_FIXTURE_TOKEN, m365FixtureFetch } from "@/eval/m365-fixtures";
import { readMail, searchMail } from "@/lib/graph/mail";
import { readTeamsThread, searchTeams } from "@/lib/graph/teams";

describe("m365FixtureFetch", () => {
  it("finds the Acme deadline chat and reads it", async () => {
    const [hit] = await searchTeams("Acme go-live deadline", M365_FIXTURE_TOKEN, m365FixtureFetch);
    expect(hit?.ref).toBe("chat:19:acme-fixture@thread.v2");
    const thread = await readTeamsThread(hit?.ref ?? "", M365_FIXTURE_TOKEN, m365FixtureFetch);
    expect(thread.text).toContain("December 12");
  });

  it("finds and reads the budget mail", async () => {
    const hits = await searchMail("training spend cap", M365_FIXTURE_TOKEN, m365FixtureFetch);
    expect(hits.map((h) => h.title)).toContain("Q1 training budget");
    const mail = await readMail("msg-budget", M365_FIXTURE_TOKEN, m365FixtureFetch);
    expect(mail.text).toContain("$4,000");
  });

  it("returns no hits for words no fixture contains", async () => {
    expect(await searchTeams("Globex invoice", M365_FIXTURE_TOKEN, m365FixtureFetch)).toEqual([]);
  });

  it("answers 404 for an item that doesn't exist", async () => {
    await expect(readMail("nope", M365_FIXTURE_TOKEN, m365FixtureFetch)).rejects.toMatchObject({
      failure: "not-found",
    });
  });

  it("refuses any token but the fixture token", async () => {
    await expect(searchMail("budget", "real-user-token", m365FixtureFetch)).rejects.toMatchObject({
      failure: "unauthorized",
    });
  });
});
