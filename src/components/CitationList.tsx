"use client";

import { Icon } from "@ingagegroup/ingage-react";
import { useId, useState } from "react";
import type { Citation } from "@/lib/chat-protocol";

function citationLabel(citation: Citation): string {
  return citation.sectionPath.join(" › ");
}

/**
 * Sources for one answer: a chip per cited section. Selecting a chip shows the quoted passage
 * and a link to the document (at the page, for PDFs). Native buttons, because the library's
 * Tag is a clickable <span> that keyboards can't reach.
 */
export default function CitationList({ citations }: { citations: Citation[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const baseId = useId();
  const open = citations.find((citation) => citation.id === openId);

  if (citations.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      <p
        style={{
          color: "var(--text-muted)",
          fontSize: "var(--fs-caption)",
          fontWeight: "var(--fw-semibold)",
        }}
      >
        Sources
      </p>
      <ul className="flex flex-wrap gap-2">
        {citations.map((citation, index) => {
          const isOpen = citation.id === openId;
          return (
            <li key={citation.id}>
              <button
                type="button"
                aria-expanded={isOpen}
                aria-controls={isOpen ? `${baseId}-quote` : undefined}
                onClick={() => setOpenId(isOpen ? null : citation.id)}
                className="inline-flex max-w-full items-center gap-2 text-left"
                style={{
                  fontFamily: "var(--font-body)",
                  fontSize: 14,
                  fontWeight: "var(--fw-medium)",
                  lineHeight: 1.3,
                  padding: "7px 12px",
                  borderRadius: "var(--radius-pill)",
                  border: `1px solid ${isOpen ? "var(--ingage-blue)" : "var(--border-subtle)"}`,
                  background: isOpen ? "var(--wash-blue-soft)" : "transparent",
                  color: isOpen ? "var(--ingage-blue)" : "var(--text-dark)",
                  cursor: "pointer",
                }}
              >
                <span aria-hidden="true" style={{ fontWeight: "var(--fw-semibold)" }}>
                  {index + 1}
                </span>
                <span className="break-words">{citationLabel(citation)}</span>
                {citation.page ? (
                  <span style={{ color: "var(--text-muted)" }}>p. {citation.page}</span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
      {open ? (
        <figure
          id={`${baseId}-quote`}
          className="flex flex-col gap-2"
          style={{
            borderLeft: "3px solid var(--ingage-blue)",
            background: "var(--surface-mist)",
            borderRadius: "var(--radius-sm)",
            padding: "12px 16px",
          }}
        >
          <figcaption
            style={{
              color: "var(--text-muted)",
              fontSize: "var(--fs-caption)",
              fontWeight: "var(--fw-semibold)",
            }}
          >
            {open.documentTitle} › {citationLabel(open)}
            {open.page ? `, page ${open.page}` : ""}
          </figcaption>
          <blockquote className="whitespace-pre-wrap" style={{ lineHeight: "var(--lh-body)" }}>
            {open.quote}
          </blockquote>
          <a
            href={open.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 self-start"
            style={{ fontSize: "var(--fs-caption)", fontWeight: "var(--fw-medium)" }}
          >
            Open in {open.documentTitle}
            <Icon name="external" size={14} />
          </a>
        </figure>
      ) : null}
    </div>
  );
}
