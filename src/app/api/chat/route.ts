import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { getCurrentUserEmail } from "@/lib/auth";
import { streamAnswer } from "@/lib/chat/answer";
import { getPassageProvider, type Passage } from "@/lib/chat/passages";
import { encodeChatEvent } from "@/lib/chat-protocol";
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

function answerStream(request: ChatRequest, passages: Passage[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      try {
        const events = streamAnswer({ ...request, passages, client: new Anthropic() });
        for await (const event of events)
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

  return new Response(answerStream(parsed.data, passages), {
    headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" },
  });
}
