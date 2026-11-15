import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { getCurrentUserEmail } from "@/lib/auth";
import { streamAnswer } from "@/lib/chat/answer";
import { getPassageProvider, type Passage } from "@/lib/chat/passages";
import { checkTopic, OFF_TOPIC, OFF_TOPIC_ANSWER } from "@/lib/chat/topic-check";
import { type ChatEvent, encodeChatEvent } from "@/lib/chat-protocol";
import { type ChatRequest, chatRequestSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

const ANSWER_FAILED = "Could not get an answer. Try again.";

function newCorrelationId(): string {
  return crypto.randomUUID().slice(0, 8);
}

/** Logs a failure without the question or answer text, which may be personal. */
function logFailure(correlationId: string, operation: string, err: unknown): void {
  console.error(`[api/chat ${correlationId}] ${operation} failed`, err);
}

async function* offTopicReply(): AsyncGenerator<ChatEvent> {
  yield { type: "delta", text: OFF_TOPIC_ANSWER };
  yield { type: "done", outcome: "off-topic", sources: [] };
}

/**
 * The question's topic, or null if the check failed. Without a classification the question
 * goes on to search, where the relevance threshold still turns away unrelated questions.
 */
async function topicOf(request: ChatRequest): Promise<string | null> {
  try {
    return await checkTopic({ ...request, client: new Anthropic() });
  } catch (err) {
    logFailure(newCorrelationId(), "topic check", err);
    return null;
  }
}

function ndjson(events: () => AsyncGenerator<ChatEvent>): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of events())
          controller.enqueue(encoder.encode(encodeChatEvent(event)));
      } catch (err) {
        const correlationId = newCorrelationId();
        logFailure(correlationId, "answer", err);
        const event = { type: "error", error: ANSWER_FAILED, correlationId } as const;
        controller.enqueue(encoder.encode(encodeChatEvent(event)));
      } finally {
        controller.close();
      }
    },
  });
  return new Response(body, {
    headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" },
  });
}

export async function POST(request: Request): Promise<Response> {
  if (!(await getCurrentUserEmail())) {
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

  if ((await topicOf(parsed.data)) === OFF_TOPIC) return ndjson(offTopicReply);

  let passages: Passage[];
  try {
    passages = await getPassageProvider()(parsed.data.question);
  } catch (err) {
    const correlationId = newCorrelationId();
    logFailure(correlationId, "retrieve passages", err);
    return NextResponse.json(
      { error: "Could not search the handbook", correlationId },
      { status: 500 },
    );
  }

  return ndjson(() => streamAnswer({ ...parsed.data, passages, client: new Anthropic() }));
}
