/** Source ids: p = handbook passage, f = file, m = mail, t = Teams. */
const MARKER = / ?\[([pfmt]\d+)\]/g;
/** A marker that may still be completed by the next chunk, or a space that may precede one. */
const POSSIBLE_START = /(?: ?\[(?:[pfmt]\d*)?| )$/;

export interface MarkerFilter {
  /** Adds streamed text; returns the text that is safe to show, with markers removed. */
  push(chunk: string): string;
  /** Returns whatever was held back at the end of the stream. */
  flush(): string;
  /** Source ids cited so far, each once, in the order first cited. */
  citedIds(): string[];
}

/**
 * Removes source markers such as `[p3]` or `[m1]` (and the space before them) from streamed answer
 * text and records which passages were cited. Text that might be the start of a marker split
 * across chunks is held back until the next chunk arrives.
 */
export function createMarkerFilter(): MarkerFilter {
  let pending = "";
  const ids: string[] = [];

  return {
    push(chunk) {
      const text = (pending + chunk).replace(MARKER, (_match, id: string) => {
        if (!ids.includes(id)) ids.push(id);
        return "";
      });
      const held = POSSIBLE_START.exec(text)?.[0] ?? "";
      pending = held;
      return text.slice(0, text.length - held.length);
    },
    flush() {
      const rest = pending;
      pending = "";
      return rest;
    },
    citedIds() {
      return [...ids];
    },
  };
}
