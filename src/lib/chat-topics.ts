/**
 * What the chat can answer, shown in its empty state. Keep this in step with the configured
 * knowledge sources: list a topic here only once its source is ingested.
 */
export type ChatTopic = { id: string; label: string; description: string };

export const CHAT_TOPICS: ChatTopic[] = [
  {
    id: "handbook",
    label: "Employee Handbook",
    description: "benefits, PTO, training budget, reviews, and other Ingage policies.",
  },
];

export const EXAMPLE_QUESTIONS: string[] = [
  "How much is my annual training budget?",
  "How do I request PTO?",
  "When do performance reviews happen?",
];

/**
 * Topics whose sources to search for a question: the one the topic check picked, or every
 * topic when the check failed or returned an id that isn't configured.
 */
export function searchTopics(topic: string | null, topics: ChatTopic[] = CHAT_TOPICS): string[] {
  const ids = topics.map((t) => t.id);
  return topic !== null && ids.includes(topic) ? [topic] : ids;
}
