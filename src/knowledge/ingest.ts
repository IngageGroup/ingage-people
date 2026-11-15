import { getActiveVersion, type NewChunk, replaceSourceContent } from "@/db/knowledge";
import { type Chunk, chunkDocument } from "@/knowledge/chunk";
import { fetchSource } from "@/knowledge/fetch";
import type { SourceConfig } from "@/knowledge/sources";

export type IngestResult =
  | { status: "unchanged"; sourceId: string }
  | { status: "stored"; sourceId: string; versionId: string; chunks: number };

export interface IngestOptions {
  /** Embeds chunk texts for storage, one vector per text, in order. */
  embed: (texts: string[]) => Promise<number[][]>;
  /** Re-ingest even when the source hasn't changed. */
  force?: boolean;
  log?: (message: string) => void;
}

/** What gets embedded: the heading context, then the text, so a chunk's topic is searchable. */
function embeddingText(title: string, chunk: Chunk): string {
  const context = [title, ...chunk.sectionPath].filter(Boolean).join(" > ");
  return context ? `${context}\n\n${chunk.text}` : chunk.text;
}

function elapsed(since: number): string {
  return `${Math.round(performance.now() - since)} ms`;
}

/**
 * Brings one source up to date: fetch, skip if unchanged, parse, chunk, embed, and swap the new
 * version in atomically. Throws on failure; the previous version then stays active.
 */
export async function ingestSource(
  source: SourceConfig,
  { embed, force = false, log = console.log }: IngestOptions,
): Promise<IngestResult> {
  const prefix = `[ingest ${source.id}]`;
  const start = performance.now();

  const fetched = await fetchSource(source);
  const active = await getActiveVersion(source.id);
  if (!force && active?.changeMarker === fetched.changeMarker) {
    log(`${prefix} unchanged since version ${active.id}; skipped`);
    return { status: "unchanged", sourceId: source.id };
  }

  const document = await fetched.load();
  const chunks = chunkDocument(document);
  const parsed = performance.now();

  const vectors = await embed(chunks.map((chunk) => embeddingText(document.title, chunk)));
  const embedded = performance.now();

  const rows: NewChunk[] = chunks.map((chunk, i) => ({
    ...chunk,
    url: chunk.page === undefined ? fetched.url : `${fetched.url}#page=${chunk.page}`,
    embedding: vectors[i] ?? [],
  }));
  const { versionId } = await replaceSourceContent({
    source,
    title: document.title || source.id,
    changeMarker: fetched.changeMarker,
    documentUpdatedAt: fetched.updatedAt,
    chunks: rows,
  });

  log(
    `${prefix} stored version ${versionId}: ${rows.length} chunks ` +
      `(fetch and parse ${Math.round(parsed - start)} ms, ` +
      `embed ${Math.round(embedded - parsed)} ms, store ${elapsed(embedded)}, ` +
      `total ${elapsed(start)})`,
  );
  return { status: "stored", sourceId: source.id, versionId, chunks: rows.length };
}
