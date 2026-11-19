import { NextResponse } from "next/server";
import { type ChatOutcomeRecord, recordChatOutcome } from "@/db/chat-stats";
import { CHAT_RATE_LIMITS, consumeChatQuota, type QuotaResult } from "@/db/rate-limit";
import { getCurrentUserEmail } from "@/lib/auth";
import { streamAnswer } from "@/lib/chat/answer";
import { chatClient } from "@/lib/chat/anthropic";
import { getPassageProvider, type Passage } from "@/lib/chat/passages";
import { checkTopic, OFF_TOPIC, OFF_TOPIC_ANSWER } from "@/lib/chat/topic-check";
import { type ChatEvent, type ChatOutcome, encodeChatEvent } from "@/lib/chat-protocol";
import { searchTopics } from "@/lib/chat-topics";
import { describeError } from "@/lib/safe-error";
import { type ChatRequest, chatRequestSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

const ANSWER_FAILED = "Could not get an answer. Try again.";

function newCorrelationId(): string {
  return crypto.randomUUID().slice(0, 8);
}

/**
 * Logs a failure without the question or answer text, which may be personal: only the
 * correlation id, the operation, and `describeError`'s sanitized form of the error.
 */
function logFailure(correlationId: string, operation: string, err: unknown): void {
  console.error(`[api/chat ${correlationId}] ${operation} failed: ${describeError(err)}`);
}

function overLimitMessage(result: Extract<QuotaResult, { allowed: false }>): string {
  return result.limit === "minute"
    ? `You've asked ${CHAT_RATE_LIMITS.perMinute} questions in the last minute. Try again in ${result.retryAfterSeconds} seconds.`
    : `You've reached today's limit of ${CHAT_RATE_LIMITS.perDay} questions. Try again tomorrow.`;
}

async function* offTopicReply(): AsyncGenerator<ChatEvent> {
  yield { type: "delta", text: OFF_TOPIC_ANSWER };
  yield { type: "done", outcome: "off-topic", sources: [] };
}

/** Topic label for outcome counts when the topic check failed. */
const UNCLASSIFIED = "unclassified";

/**
 * The question's topic, or "unclassified" if the check failed. Without a classification the
 * question goes on to search, where the relevance threshold still turns away unrelated ones.
 */
async function topicOf(request: ChatRequest): Promise<string> {
  try {
    return await checkTopic({ ...request, client: chatClient() });
  } catch (err) {
    logFailure(newCorrelationId(), "topic check", err);
    return UNCLASSIFIED;
  }
}

/** Adds the answer to the daily outcome counts. A failure is logged and doesn't affect the reply. */
async function recordOutcome(record: ChatOutcomeRecord): Promise<void> {
  try {
    await recordChatOutcome(record);
  } catch (err) {
    logFailure(newCorrelationId(), "record outcome", err);
  }
}

function ndjson(topic: string, events: () => AsyncGenerator<ChatEvent>): Response {
  const encoder = new TextEncoder();
  let outcome: ChatOutcome | "error" = "error";
  const citedSections: string[][] = [];
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of events()) {
          if (event.type === "citation") citedSections.push(event.citation.sectionPath);
          if (event.type === "done") outcome = event.outcome;
          controller.enqueue(encoder.encode(encodeChatEvent(event)));
        }
      } catch (err) {
        const correlationId = newCorrelationId();
        logFailure(correlationId, "answer", err);
        const event = { type: "error", error: ANSWER_FAILED, correlationId } as const;
        controller.enqueue(encoder.encode(encodeChatEvent(event)));
      } finally {
        const cited = outcome === "answered" ? citedSections : [];
        await recordOutcome({ topic, outcome, citedSections: cited });
        controller.close();
      }
    },
  });
  return new Response(body, {
    headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" },
  });
}

export async function POST(request: Request): Promise<Response> {
  const email = await getCurrentUserEmail();
  if (!email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON" }, { status: 400 });
  }

  const parsed = chatRequestSchema.safeParse(body);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Invalid request body";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  let quota: QuotaResult;
  try {
    quota = await consumeChatQuota(email);
  } catch (err) {
    const correlationId = newCorrelationId();
    logFailure(correlationId, "check question limit", err);
    return NextResponse.json(
      { error: "Could not check your question limit", correlationId },
      { status: 500 },
    );
  }
  if (!quota.allowed) {
    return NextResponse.json(
      { error: overLimitMessage(quota) },
      { status: 429, headers: { "retry-after": String(quota.retryAfterSeconds) } },
    );
  }

  const topic = await topicOf(parsed.data);
  if (topic === OFF_TOPIC) return ndjson(topic, offTopicReply);

  let passages: Passage[];
  try {
    passages = await getPassageProvider()(parsed.data.question, searchTopics(topic));
  } catch (err) {
    const correlationId = newCorrelationId();
    logFailure(correlationId, "retrieve passages", err);
    await recordOutcome({ topic, outcome: "error", citedSections: [] });
    return NextResponse.json(
      { error: "Could not search the handbook", correlationId },
      { status: 500 },
    );
  }

  return ndjson(topic, () => streamAnswer({ ...parsed.data, passages, client: chatClient() }));
}
