import type { DocumentSection, ParsedDocument } from "@/knowledge/document";

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

/**
 * Splits Markdown into sections by heading. The `#` heading is the title; `##` to `######`
 * headings form each section's heading path. Headings with no text under them are skipped.
 */
export function parseMarkdown(markdown: string): ParsedDocument {
  const sections: DocumentSection[] = [];
  let title = "";
  const headings: string[] = [];
  let body: string[] = [];
  let inFence = false;

  function closeSection() {
    const text = body.join("\n").trim();
    if (text) sections.push({ headingPath: [...headings], text });
    body = [];
  }

  for (const line of markdown.split("\n")) {
    if (FENCE.test(line)) inFence = !inFence;
    const heading = inFence ? null : HEADING.exec(line);
    if (!heading) {
      body.push(line);
      continue;
    }
    closeSection();
    const level = heading[1]?.length ?? 1;
    const name = heading[2] ?? "";
    if (level === 1) {
      title = name;
      headings.length = 0;
    } else {
      headings.length = Math.min(headings.length, level - 2);
      headings.push(name);
    }
  }
  closeSection();
  return { title, sections };
}
