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

const TABLE_SEPARATOR = /^\|( --- \|)+$/;

/**
 * Splits a Markdown table between rows, each piece starting with the header row, so every
 * chunk of the table can be read on its own. Null if the text isn't a table, or a single row
 * is too long to fit with the header.
 */
function tablePieces(text: string, max: number): string[] | null {
  const lines = text.trimEnd().split("\n");
  const [header, separator, ...rows] = lines;
  if (!header || !separator || !TABLE_SEPARATOR.test(separator)) return null;
  if (!lines.every((line) => line.startsWith("|"))) return null;
  const head = `${header}\n${separator}\n`;
  const result: string[] = [];
  let current = head;
  for (const row of rows) {
    if (current !== head && (current + row).length > max) {
      result.push(`${current.trimEnd()}\n\n`);
      current = head;
    }
    current += `${row}\n`;
  }
  result.push(`${current.trimEnd()}\n\n`);
  return result.every((piece) => piece.trim().length <= max) ? result : null;
}

/** Breaks text into pieces no longer than max: paragraphs (tables by rows), then sentences, then words. */
function pieces(text: string, max: number, level = 0): string[] {
  if (text.length <= max) return [text];
  const table = tablePieces(text, max);
  if (table) return table;
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
    // Table rows don't carry over: a table piece repeats its header instead.
    const tableEdge = piece.startsWith("|") || current.trimEnd().endsWith("|");
    const overlap = tableEdge ? "" : tail(current.trim(), overlapChars);
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
