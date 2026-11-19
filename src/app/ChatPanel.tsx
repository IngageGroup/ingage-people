"use client";

import { Button, Card, Input, Toast } from "@ingagegroup/ingage-react";
import { useEffect, useRef, useState } from "react";
import CitationList from "@/components/CitationList";
import EmptyState from "@/components/EmptyState";
import { HR_CONTACT } from "@/lib/app-config";
import { buildHistory } from "@/lib/chat-history";
import {
  type ChatOutcome,
  type ChatSource,
  ChatStreamError,
  type Citation,
  readChatStream,
} from "@/lib/chat-protocol";
import type { ChatTopic } from "@/lib/chat-topics";
import { CHAT_QUESTION_MAX } from "@/lib/validation";

type Exchange = {
  id: string;
  question: string;
  answer: string;
  citations: Citation[];
  status: "pending" | "streaming" | "done" | "error";
  outcome?: ChatOutcome;
  sources?: ChatSource[];
  error?: string;
  correlationId?: string;
};

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeZone: "UTC" });

function formatDate(isoDate: string): string {
  return DATE_FORMAT.format(new Date(`${isoDate}T00:00:00Z`));
}

/** Message for a response that failed before the stream started. */
async function errorFromResponse(res: Response): Promise<ChatStreamError> {
  if (res.status === 401) {
    return new ChatStreamError("Your session has expired. Reload the page to sign in again.");
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string; correlationId?: string };
  return new ChatStreamError(
    data.error ?? `Something went wrong (status ${res.status}). Try again.`,
    data.correlationId,
  );
}

/** What the server is answering; Microsoft 365 topics depend on `M365_TOOLS`. */
export interface ChatScope {
  topics: ChatTopic[];
  examples: string[];
  /** Whether answers can come from the user's own Microsoft 365 data. */
  m365: boolean;
}

function ExampleQuestions({
  scope,
  onAsk,
}: {
  scope: ChatScope;
  onAsk: (question: string) => void;
}) {
  return (
    <EmptyState icon="ai-brain" title="Ask About Working at Ingage">
      <span className="flex flex-col items-center gap-4">
        <span>
          Ask a question in plain English and get a short answer with a link to the section it came
          from. I can help with:{" "}
          {scope.topics.map((topic) => `${topic.label}: ${topic.description}`).join(" ")}
        </span>
        <span className="flex flex-col items-stretch gap-2 sm:items-center">
          {scope.examples.map((question) => (
            <button
              key={question}
              type="button"
              onClick={() => onAsk(question)}
              style={{
                fontFamily: "var(--font-body)",
                fontSize: 14,
                fontWeight: "var(--fw-medium)",
                padding: "8px 14px",
                borderRadius: "var(--radius-pill)",
                border: "1px solid var(--border-subtle)",
                background: "var(--surface-card)",
                color: "var(--text-dark)",
                cursor: "pointer",
              }}
            >
              {question}
            </button>
          ))}
        </span>
      </span>
    </EmptyState>
  );
}

function ExchangeView({ exchange, onRetry }: { exchange: Exchange; onRetry: () => void }) {
  const busy = exchange.status === "pending" || exchange.status === "streaming";
  return (
    <article className="flex flex-col gap-3" aria-busy={busy}>
      <div className="flex justify-end">
        <p
          className="max-w-[85%] whitespace-pre-wrap break-words"
          style={{
            background: "var(--surface-mist)",
            color: "var(--text-dark)",
            borderRadius: "var(--radius-lg)",
            padding: "10px 16px",
            lineHeight: "var(--lh-body)",
          }}
        >
          <span className="sr-only">You asked: </span>
          {exchange.question}
        </p>
      </div>

      {exchange.status === "error" ? (
        <div className="flex flex-col gap-3">
          <Toast tone="error" title="Could not get an answer." style={{ maxWidth: "none" }}>
            {exchange.error}
            {exchange.correlationId ? ` (Reference: ${exchange.correlationId})` : ""}
          </Toast>
          {exchange.answer ? (
            <p className="whitespace-pre-wrap" style={{ color: "var(--text-muted)" }}>
              {exchange.answer}
            </p>
          ) : null}
          <div>
            <Button variant="secondary" size="sm" icon={null} onClick={onRetry}>
              Try Again
            </Button>
          </div>
        </div>
      ) : (
        <Card padding={20} className="flex flex-col gap-4">
          {exchange.status === "pending" ? (
            <p role="status" style={{ color: "var(--text-muted)" }}>
              Searching…
            </p>
          ) : (
            <p
              className="whitespace-pre-wrap break-words"
              style={{ lineHeight: "var(--lh-body)", color: "var(--text-body)" }}
            >
              {exchange.answer}
            </p>
          )}
          {exchange.status === "done" && exchange.outcome === "answered" ? (
            <CitationList citations={exchange.citations} />
          ) : null}
          {exchange.status === "done" && exchange.sources && exchange.sources.length > 0 ? (
            <p style={{ color: "var(--text-muted)", fontSize: "var(--fs-caption)" }}>
              {exchange.sources
                .map((source) => `${source.title} last updated ${formatDate(source.lastUpdated)}`)
                .join(". ")}
              .
            </p>
          ) : null}
        </Card>
      )}
    </article>
  );
}

/**
 * The chat: questions and streamed answers from /api/chat. The conversation lives only in this
 * component's state; nothing is stored in the browser or on the server, so a reload clears it.
 */
export default function ChatPanel({ scope }: { scope: ChatScope }) {
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [draft, setDraft] = useState("");
  const [fieldError, setFieldError] = useState<string | undefined>();
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const busy = exchanges.some((e) => e.status === "pending" || e.status === "streaming");

  useEffect(() => () => abortRef.current?.abort(), []);

  // Bring a new question into view; don't follow every streamed word.
  const exchangeCount = exchanges.length;
  useEffect(() => {
    if (exchangeCount > 0) endRef.current?.scrollIntoView({ block: "end" });
  }, [exchangeCount]);

  function update(id: string, patch: Partial<Exchange> | ((e: Exchange) => Partial<Exchange>)) {
    setExchanges((all) =>
      all.map((e) =>
        e.id === id ? { ...e, ...(typeof patch === "function" ? patch(e) : patch) } : e,
      ),
    );
  }

  async function ask(rawQuestion: string, replaceId?: string) {
    const question = rawQuestion.trim();
    if (busy) return;
    if (!question) {
      setFieldError("Type a question first.");
      return;
    }
    if (question.length > CHAT_QUESTION_MAX) {
      setFieldError(`Questions must be ${CHAT_QUESTION_MAX} characters or fewer.`);
      return;
    }
    setFieldError(undefined);

    const earlier = exchanges.filter(
      (e) => e.id !== replaceId && e.status === "done" && e.answer.length > 0,
    );
    const history = buildHistory(earlier);
    const id = crypto.randomUUID();
    const fresh: Exchange = { id, question, answer: "", citations: [], status: "pending" };
    setExchanges((all) => [...all.filter((e) => e.id !== replaceId), fresh]);
    if (!replaceId) setDraft("");

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question, history }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw await errorFromResponse(res);

      for await (const event of readChatStream(res.body)) {
        if (event.type === "delta") {
          update(id, (e) => ({ status: "streaming", answer: e.answer + event.text }));
        } else if (event.type === "citation") {
          update(id, (e) => ({ citations: [...e.citations, event.citation] }));
        } else if (event.type === "done") {
          update(id, { status: "done", outcome: event.outcome, sources: event.sources });
        }
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      console.error("[chat] ask failed", err instanceof Error ? err.name : "unknown");
      const message =
        err instanceof ChatStreamError ? err.message : "Could not reach the server. Try again.";
      update(id, {
        status: "error",
        error: message,
        ...(err instanceof ChatStreamError && err.correlationId
          ? { correlationId: err.correlationId }
          : {}),
      });
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }

  function startOver() {
    abortRef.current?.abort();
    setExchanges([]);
    setDraft("");
    setFieldError(undefined);
  }

  return (
    <section className="flex min-h-full flex-col gap-6">
      {exchanges.length > 0 ? (
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" icon={null} onClick={startOver}>
            New Chat
          </Button>
        </div>
      ) : null}
      <div className="flex flex-1 flex-col gap-8" aria-live="polite">
        {exchanges.length === 0 ? (
          <ExampleQuestions scope={scope} onAsk={(question) => void ask(question)} />
        ) : (
          exchanges.map((exchange) => (
            <ExchangeView
              key={exchange.id}
              exchange={exchange}
              onRetry={() => void ask(exchange.question, exchange.id)}
            />
          ))
        )}
        <div ref={endRef} />
      </div>

      {/* No <form>: the library's Button renders <button> without type and would submit it. */}
      <div
        className="sticky bottom-0 flex flex-col gap-2 pt-3 pb-2"
        style={{ background: "var(--surface-page)" }}
      >
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            {/* Kept compact for phones: the placeholder shows, aria-label names the field. */}
            <Input
              aria-label="Your question"
              placeholder="Ask a question"
              value={draft}
              maxLength={CHAT_QUESTION_MAX}
              autoComplete="off"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) void ask(draft);
              }}
              {...(fieldError ? { error: fieldError } : {})}
            />
          </div>
          <Button icon="arrow-right" disabled={busy} onClick={() => void ask(draft)}>
            Ask
          </Button>
        </div>
        <p style={{ color: "var(--text-muted)", fontSize: "var(--fs-caption)" }}>
          {scope.m365
            ? "Answers come from the handbook and your Microsoft 365 data and can be wrong. HR is the authority on policy, and this isn't legal advice."
            : "Answers come from the handbook and can be wrong. HR is the authority, and this isn't legal advice."}{" "}
          Nothing you ask is saved. Questions for HR: {HR_CONTACT.name},{" "}
          <a href={`mailto:${HR_CONTACT.email}`}>{HR_CONTACT.email}</a>.
        </p>
      </div>
    </section>
  );
}
