import { describe, expect, it } from "vitest";
import { type ChatTopic, searchTopics } from "@/lib/chat-topics";

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
