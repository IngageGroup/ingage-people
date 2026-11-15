import type { ParsedDocument } from "@/knowledge/document";

export interface Chunk {
  text: string;
  sectionPath: string[];
  page?: number;
}

export interface ChunkLimits {
  maxChars: number;
  overlapChars: number;
}

export const DEFAULT_CHUNK_LIMITS: ChunkLimits = { maxChars: 2000, overlapChars: 200 };

// Each split keeps the separator on the piece before it, so joining the pieces restores the text.
const SPLITTERS = [/(?<=\n\s*\n)/, /(?<=[.!?]["')\]]?\s+)/, /(?<=\s+)/];

/** Breaks text into pieces no longer than max: paragraphs, then sentences, then words. */
function pieces(text: string, max: number, level = 0): string[] {
  if (text.length <= max) return [text];
  const splitter = SPLITTERS[level];
  if (!splitter) {
    const cuts: string[] = [];
    for (let i = 0; i < text.length; i += max) cuts.push(text.slice(i, i + max));
    return cuts;
  }
  return text.split(splitter).flatMap((part) => pieces(part, max, level + 1));
}

/** The last `overlap` characters of text, starting at a word. */
function tail(text: string, overlap: number): string {
  if (overlap === 0) return "";
  const end = text.slice(-overlap);
  const space = end.search(/\s/);
  return space === -1 ? "" : end.slice(space).trimStart();
}

function splitSection(text: string, { maxChars, overlapChars }: ChunkLimits): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const piece of pieces(text.trim(), maxChars)) {
    if ((current + piece).trim().length <= maxChars) {
      current += piece;
      continue;
    }
    chunks.push(current.trim());
    const overlap = tail(current.trim(), overlapChars);
    current = `${overlap} ${piece}`.trim().length <= maxChars ? `${overlap} ${piece}` : piece;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

/**
 * Splits a document into chunks along its sections. A section shorter than the cap is one
 * chunk; a longer one is split at paragraph, then sentence, then word breaks, and each later
 * piece repeats the end of the one before it. Sections are never merged, so every chunk
 * belongs to exactly one heading path.
 */
export function chunkDocument(
  document: ParsedDocument,
  limits: ChunkLimits = DEFAULT_CHUNK_LIMITS,
): Chunk[] {
  if (limits.overlapChars >= limits.maxChars) {
    throw new Error(
      `overlapChars (${limits.overlapChars}) must be smaller than maxChars (${limits.maxChars})`,
    );
  }
  return document.sections.flatMap((section) =>
    splitSection(section.text, limits).map((text) => ({
      text,
      sectionPath: section.headingPath,
      ...(section.page === undefined ? {} : { page: section.page }),
    })),
  );
}
