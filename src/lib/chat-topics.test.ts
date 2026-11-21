import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ChatTopic,
  chatTopics,
  exampleQuestions,
  m365Enabled,
  searchTopics,
} from "@/lib/chat-topics";

afterEach(() => {
  vi.unstubAllEnvs();
});

const TOPICS: ChatTopic[] = [
  { id: "handbook", label: "Handbook", description: "policies." },
  { id: "dev-onboarding", label: "Developer Onboarding", description: "setup." },
];

describe("searchTopics", () => {
  it("searches the topic the check picked", () => {
    expect(searchTopics("dev-onboarding", TOPICS)).toEqual(["dev-onboarding"]);
  });

  it("searches every topic when the check couldn't tell", () => {
    expect(searchTopics(null, TOPICS)).toEqual(["handbook", "dev-onboarding"]);
  });

  it("searches every topic for an id it doesn't know", () => {
    expect(searchTopics("retired-topic", TOPICS)).toEqual(["handbook", "dev-onboarding"]);
  });
});

describe("Microsoft 365 topics", () => {
  it("offers only the knowledge topics while M365_TOOLS is off", () => {
    vi.stubEnv("M365_TOOLS", "");
    expect(m365Enabled()).toBe(false);
    expect(chatTopics().map((t) => t.id)).toEqual(["handbook"]);
    expect(exampleQuestions().join(" ")).not.toContain("Teams");
  });

  it("adds the work topic and a Teams example when M365_TOOLS is enabled", () => {
    vi.stubEnv("M365_TOOLS", "enabled");
    expect(m365Enabled()).toBe(true);
    expect(chatTopics().map((t) => t.id)).toEqual(["handbook", "work"]);
    expect(exampleQuestions()).toContain(
      "What did my client say about the deadline in Teams this week?",
    );
  });

  it("never searches the knowledge store for the work topic", () => {
    vi.stubEnv("M365_TOOLS", "enabled");
    expect(searchTopics("work")).toEqual(["handbook"]);
  });
});

describe("work topic", () => {
  it("covers the calendar and growth hours, so the topic check keeps those questions", () => {
    vi.stubEnv("M365_TOOLS", "enabled");
    const work = chatTopics().find((topic) => topic.id === "work");
    expect(work?.description).toContain("calendar");
    expect(work?.description).toContain("growth hours");
  });
});
