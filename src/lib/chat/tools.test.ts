import { ToolError } from "@anthropic-ai/sdk/lib/tools/ToolError";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Passage } from "@/lib/chat/passages";
import type { Skill } from "@/lib/chat/skills";
import { SourceRegistry } from "@/lib/chat/sources";
import { chatTools } from "@/lib/chat/tools";
import { GraphTokenError } from "@/lib/graph-token";

const PASSAGE: Passage = {
  id: "c1",
  sectionPath: ["Time Off"],
  text: "Request PTO two weeks ahead.",
  documentTitle: "Handbook",
  url: "https://example.test/handbook.pdf",
  lastUpdated: "2026-10-01",
};

const mailHits = {
  value: [
    {
      hitsContainers: [
        {
          hits: [
            {
              hitId: "msg-1",
              summary: "deadline Friday",
              resource: {
                subject: "Deadline",
                from: { emailAddress: { name: "Jane" } },
                receivedDateTime: "2026-11-17T09:30:00Z",
              },
            },
          ],
        },
      ],
    },
  ],
};

type ChatTool = ReturnType<typeof chatTools>[number];

const SKILL: Skill = {
  name: "organize-growth-hours",
  description: "Organize growth hours.",
  requires: ["m365"],
  body: "Step one.",
};

function setup(
  overrides: { graphToken?: () => Promise<string>; fetchStatus?: number; skills?: Skill[] } = {},
) {
  const registry = new SourceRegistry();
  const passages = vi.fn(async (_q: string, _topics: string[]) => [PASSAGE]);
  const graphToken = vi.fn(overrides.graphToken ?? (async () => "user-token"));
  const fetchFn = vi.fn(
    async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify(overrides.fetchStatus ? {} : mailHits), {
        status: overrides.fetchStatus ?? 200,
      }),
  );
  const tools = chatTools({
    registry,
    passages,
    handbookTopics: ["handbook"],
    graphToken,
    fetchFn,
    timeZone: "America/New_York",
    skills: overrides.skills ?? [SKILL],
  });
  const run = (name: string, input: Record<string, string>) => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`no tool ${name}`);
    // Each tool takes either { query } or { ref }; the test passes the one that tool expects.
    const runTool = tool.run as (args: Record<string, string>) => ReturnType<ChatTool["run"]>;
    return runTool(input);
  };
  return { registry, passages, graphToken, fetchFn, tools, run };
}

beforeEach(() => {
  vi.stubEnv("M365_TOOLS", "enabled");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("chatTools", () => {
  it("offers the handbook search, skills, and the Microsoft 365 and calendar tools", () => {
    expect(setup().tools.map((t) => t.name)).toEqual([
      "search_handbook",
      "load_skill",
      "search_files",
      "read_file",
      "search_mail",
      "read_mail",
      "search_teams",
      "read_teams_thread",
      "list_calendar_events",
      "tally_hours",
    ]);
  });

  it("offers only the handbook search unless M365_TOOLS is enabled", () => {
    vi.stubEnv("M365_TOOLS", "");
    expect(setup({ skills: [] }).tools.map((t) => t.name)).toEqual(["search_handbook"]);
  });

  it("leaves out load_skill when there are no skills", () => {
    expect(setup({ skills: [] }).tools.map((t) => t.name)).not.toContain("load_skill");
  });

  it("loads a skill's instructions by name", async () => {
    expect(await setup().run("load_skill", { name: "organize-growth-hours" })).toBe("Step one.");
  });

  it("names the available skills when asked for an unknown one", async () => {
    await expect(Promise.resolve(setup().run("load_skill", { name: "x" }))).rejects.toMatchObject({
      content: "No skill named x. Available: organize-growth-hours",
    });
  });

  it("searches the handbook topics and registers the passages without a Graph token", async () => {
    const { run, passages, graphToken, registry } = setup();
    const result = await run("search_handbook", { query: "pto" });
    expect(passages).toHaveBeenCalledWith("pto", ["handbook"]);
    expect(graphToken).not.toHaveBeenCalled();
    expect(result).toContain('<passage id="p1"');
    expect(registry.citation("p1")?.quote).toBe("Request PTO two weeks ahead.");
  });

  it("says so when the handbook has nothing above the threshold", async () => {
    const { run, passages } = setup();
    passages.mockResolvedValueOnce([]);
    expect(await run("search_handbook", { query: "pets" })).toBe("No handbook passages matched.");
  });

  it("calls Graph with the signed-in user's token and registers the items", async () => {
    const { run, fetchFn, registry } = setup();
    const result = await run("search_mail", { query: "deadline" });
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer user-token");
    expect(result).toContain('<item id="m1" kind="mail" ref="msg-1"');
    expect(registry.citation("m1")?.documentTitle).toBe("Deadline");
  });

  it("reports Microsoft 365 as unavailable under the auth bypass", async () => {
    const { run } = setup({
      graphToken: () => Promise.reject(new GraphTokenError("unavailable", "bypass")),
    });
    const error = await Promise.resolve(run("search_mail", { query: "x" })).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).content).toBe("Microsoft 365 isn't available in this session.");
  });

  it("asks the user to sign in again when the token can't be refreshed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { run } = setup({
      graphToken: () => Promise.reject(new GraphTokenError("refresh-failed", "expired")),
    });
    await expect(Promise.resolve(run("search_files", { query: "x" }))).rejects.toMatchObject({
      content: "Microsoft 365 sign-in has expired; ask the user to sign in again.",
    });
  });

  it("says an item can't be opened when Graph returns 403", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { run } = setup({ fetchStatus: 403 });
    await expect(Promise.resolve(run("read_mail", { ref: "msg-1" }))).rejects.toMatchObject({
      content: "That item can't be opened with your access.",
    });
    expect(log.mock.calls.join(" ")).not.toContain("user-token");
  });

  it("says Microsoft 365 is busy when Graph throttles", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { run } = setup({ fetchStatus: 429 });
    await expect(Promise.resolve(run("search_teams", { query: "x" }))).rejects.toMatchObject({
      content: "Microsoft 365 is busy; try again shortly.",
    });
  });

  it("logs an unexpected failure and gives Claude a generic message", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { run, passages } = setup();
    passages.mockRejectedValueOnce(new Error("connection refused for user@x.com"));
    await expect(Promise.resolve(run("search_handbook", { query: "pto" }))).rejects.toMatchObject({
      content: "The search failed; try again.",
    });
    expect(log).toHaveBeenCalledWith("[chat-tools] search_handbook failed: Error");
  });

  it("says when a search finds nothing", async () => {
    const { run, fetchFn } = setup();
    fetchFn.mockResolvedValueOnce(new Response(JSON.stringify({ value: [] })));
    expect(await run("search_files", { query: "nothing" })).toBe("No files matched.");
  });
});
