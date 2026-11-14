import { z } from "zod";

/**
 * Wire format between the chat UI and POST /api/chat.
 *
 * The response is newline-delimited JSON (`application/x-ndjson`): one `ChatEvent` per line.
 * A successful stream sends any number of `delta` and `citation` events and ends with exactly
 * one `done`. A failure after the stream has started ends with one `error` instead. Failures
 * before the stream starts (401, 400, 429, 500) are ordinary JSON responses with
 * `{ error, correlationId? }`, matching the other routes.
 */

export const citationSchema = z.object({
  /** Passage id the answer cites, e.g. "p3". Unique within one answer. */
  id: z.string().min(1),
  /** Heading path in the source document, e.g. ["Benefits", "Training Budget"]. */
  sectionPath: z.array(z.string()).min(1),
  /** The passage text the answer relies on. */
  quote: z.string(),
  /** Document title, e.g. "Ingage Employee Handbook". */
  documentTitle: z.string(),
  /** Link to the document; for PDFs it already includes `#page=N`. */
  url: z.url(),
  page: z.number().int().positive().optional(),
});

export type Citation = z.infer<typeof citationSchema>;

export const chatOutcomeSchema = z.enum(["answered", "dont-know", "off-topic"]);
export type ChatOutcome = z.infer<typeof chatOutcomeSchema>;

export const chatSourceSchema = z.object({
  title: z.string(),
  /** ISO date of the source version the answer used. */
  lastUpdated: z.iso.date(),
});

export type ChatSource = z.infer<typeof chatSourceSchema>;

export const chatEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("delta"), text: z.string() }),
  z.object({ type: z.literal("citation"), citation: citationSchema }),
  z.object({
    type: z.literal("done"),
    outcome: chatOutcomeSchema,
    /** Source versions used, for the "last updated" note. Empty for off-topic. */
    sources: z.array(chatSourceSchema),
  }),
  z.object({ type: z.literal("error"), error: z.string(), correlationId: z.string().optional() }),
]);

export type ChatEvent = z.infer<typeof chatEventSchema>;

export class ChatStreamError extends Error {
  constructor(
    message: string,
    readonly correlationId?: string,
  ) {
    super(message);
    this.name = "ChatStreamError";
  }
}

/**
 * Reads an NDJSON body and yields each validated event. Throws `ChatStreamError` on a
 * malformed line, an `error` event, or a stream that ends without `done`.
 */
export async function* readChatStream(body: ReadableStream<Uint8Array>): AsyncGenerator<ChatEvent> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let finished = false;

  function parseLine(line: string): ChatEvent {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      throw new ChatStreamError("The server sent a malformed response.");
    }
    const parsed = chatEventSchema.safeParse(json);
    if (!parsed.success) throw new ChatStreamError("The server sent an unexpected response.");
    if (parsed.data.type === "error") {
      throw new ChatStreamError(parsed.data.error, parsed.data.correlationId);
    }
    return parsed.data;
  }

  try {
    while (!finished) {
      const { value, done } = await reader.read();
      if (done) {
        if (buffer.trim()) {
          const event = parseLine(buffer);
          if (event.type === "done") finished = true;
          yield event;
        }
        break;
      }
      buffer += value;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) {
          const event = parseLine(line);
          yield event;
          if (event.type === "done") {
            finished = true;
            break;
          }
        }
        newline = buffer.indexOf("\n");
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  if (!finished) throw new ChatStreamError("The answer was cut off. Try again.");
}

/** Serialises one event as an NDJSON line. For the route and test fixtures. */
export function encodeChatEvent(event: ChatEvent): string {
  return `${JSON.stringify(event)}\n`;
}
