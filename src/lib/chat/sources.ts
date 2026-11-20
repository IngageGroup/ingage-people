import type { Passage } from "@/lib/chat/passages";
import type { ChatSource, Citation } from "@/lib/chat-protocol";
import type { CalendarEvent } from "@/lib/graph/calendar";
import type { M365Item, M365Kind } from "@/lib/graph/m365-item";

/** Longest quote shown under a Microsoft 365 citation. */
const M365_QUOTE_MAX = 1000;

type IdPrefix = "p" | "f" | "m" | "t" | "c";

const PREFIX: Record<M365Kind, IdPrefix> = { file: "f", mail: "m", teams: "t" };

/** Where a citation links when Graph returned no usable link for the item. */
const KIND_HOME: Record<M365Kind, string> = {
  file: "https://www.office.com/",
  mail: "https://outlook.office.com/mail/",
  teams: "https://teams.microsoft.com/",
};

export type RegisteredItem = M365Item & { id: string };

/** A calendar event the calendar tool listed this answer; for `tally_hours`, not a citation. */
export type RegisteredEvent = CalendarEvent & { id: string };

function linkFor(item: M365Item): string {
  return URL.canParse(item.url) ? item.url : KIND_HOME[item.kind];
}

function isoDate(dateTime: string): string | undefined {
  const date = dateTime.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined;
}

function passageCitation(passage: Passage): Citation {
  return {
    id: passage.id,
    sectionPath: passage.sectionPath,
    quote: passage.text,
    documentTitle: passage.documentTitle,
    url: passage.url,
    ...(passage.page ? { page: passage.page } : {}),
  };
}

function itemCitation(item: RegisteredItem): Citation {
  return {
    id: item.id,
    sectionPath: item.location,
    quote: item.text.slice(0, M365_QUOTE_MAX),
    documentTitle: item.title,
    url: linkFor(item),
  };
}

/**
 * Everything the tools returned during one answer, under the ids Claude cites. Ids are only
 * handed out here, so a cited id that a tool didn't return in this request has no citation.
 */
export class SourceRegistry {
  private readonly citations = new Map<string, Citation>();
  private readonly sources = new Map<string, ChatSource>();
  private readonly counts: Record<IdPrefix, number> = { p: 0, f: 0, m: 0, t: 0, c: 0 };
  /** By Graph id, so listing the same period again reuses ids instead of doubling hours. */
  private readonly calendar = new Map<string, RegisteredEvent>();

  private nextId(prefix: IdPrefix): string {
    this.counts[prefix] += 1;
    return `${prefix}${this.counts[prefix]}`;
  }

  addPassages(passages: Passage[]): Passage[] {
    return passages.map((original) => {
      const passage = { ...original, id: this.nextId("p") };
      this.citations.set(passage.id, passageCitation(passage));
      this.sources.set(passage.id, {
        title: passage.documentTitle,
        lastUpdated: passage.lastUpdated,
      });
      return passage;
    });
  }

  addItems(items: M365Item[]): RegisteredItem[] {
    return items.map((original) => {
      const item = { ...original, id: this.nextId(PREFIX[original.kind]) };
      this.citations.set(item.id, itemCitation(item));
      const lastUpdated = isoDate(item.lastModified);
      if (lastUpdated) this.sources.set(item.id, { title: item.title, lastUpdated });
      return item;
    });
  }

  addEvents(events: CalendarEvent[]): RegisteredEvent[] {
    return events.map((event) => {
      const known = this.calendar.get(event.graphId);
      if (known) return known;
      const registered = { ...event, id: this.nextId("c") };
      this.calendar.set(event.graphId, registered);
      return registered;
    });
  }

  events(): RegisteredEvent[] {
    return [...this.calendar.values()];
  }

  citation(id: string): Citation | undefined {
    return this.citations.get(id);
  }

  source(id: string): ChatSource | undefined {
    return this.sources.get(id);
  }
}

export function renderPassages(passages: Passage[]): string {
  return passages
    .map(
      (p) =>
        `<passage id="${p.id}" document="${p.documentTitle}" section="${p.sectionPath.join(" › ")}">\n${p.text}\n</passage>`,
    )
    .join("\n");
}

function attribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** Microsoft 365 text is untrusted: it must not be able to close its item or open a tag. */
function escapeText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function renderItems(items: RegisteredItem[]): string {
  return items
    .map((item) => {
      const attributes = [
        `id="${item.id}"`,
        `kind="${item.kind}"`,
        `ref="${attribute(item.ref)}"`,
        `title="${attribute(item.title)}"`,
        `location="${attribute(item.location.join(" › "))}"`,
        `date="${attribute(item.lastModified)}"`,
      ];
      return `<item ${attributes.join(" ")}>\n${escapeText(item.text)}\n</item>`;
    })
    .join("\n");
}
