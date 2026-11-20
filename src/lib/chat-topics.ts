/**
 * What the chat can answer, shown in its empty state and used by the topic check. Keep the
 * knowledge topics in step with the configured sources: list one only once it's ingested.
 */
export type ChatTopic = { id: string; label: string; description: string };

/** Topics answered from the knowledge store (`search_handbook`). */
export const KNOWLEDGE_TOPICS: ChatTopic[] = [
  {
    id: "handbook",
    label: "Employee Handbook",
    description: "benefits, PTO, training budget, reviews, and other Ingage policies.",
  },
];

/** Answered from the user's own Microsoft 365 data, only while the tools are on. */
export const WORK_TOPIC: ChatTopic = {
  id: "work",
  label: "Your work",
  description:
    "your clients, projects, files, mail, Teams messages, and calendar, including organizing your growth hours.",
};

const KNOWLEDGE_EXAMPLES = [
  "How much is my annual training budget?",
  "How do I request PTO?",
  "When do performance reviews happen?",
];

const WORK_EXAMPLE = "What did my client say about the deadline in Teams this week?";

/** Microsoft 365 tools are on only where `M365_TOOLS=enabled` (dev until #2 is decided). */
export function m365Enabled(): boolean {
  return process.env["M365_TOOLS"] === "enabled";
}

export function chatTopics(): ChatTopic[] {
  return m365Enabled() ? [...KNOWLEDGE_TOPICS, WORK_TOPIC] : KNOWLEDGE_TOPICS;
}

export function exampleQuestions(): string[] {
  return m365Enabled() ? [...KNOWLEDGE_EXAMPLES, WORK_EXAMPLE] : KNOWLEDGE_EXAMPLES;
}

/**
 * Knowledge topics `search_handbook` searches for a question: the one the topic check picked,
 * or every knowledge topic when the check failed, picked the work topic, or returned an id
 * that isn't configured.
 */
export function searchTopics(
  topic: string | null,
  topics: ChatTopic[] = KNOWLEDGE_TOPICS,
): string[] {
  const ids = topics.map((t) => t.id);
  return topic !== null && ids.includes(topic) ? [topic] : ids;
}
