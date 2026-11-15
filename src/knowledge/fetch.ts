import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ParsedDocument } from "@/knowledge/document";
import { parseMarkdown } from "@/knowledge/markdown";
import { parsePdf } from "@/knowledge/pdf";
import type { LocalFileSource, SourceConfig } from "@/knowledge/sources";

/** What a source looks like now. `load` does the expensive part, only when it changed. */
export interface FetchedSource {
  /** Compared with the active version's marker to skip unchanged sources. */
  changeMarker: string;
  updatedAt: Date;
  /** Link to the document; chunks with a page add `#page=N`. */
  url: string;
  load: () => Promise<ParsedDocument>;
}

const PARSERS: Record<string, (bytes: Buffer) => Promise<ParsedDocument>> = {
  ".md": async (bytes) => parseMarkdown(bytes.toString("utf8")),
  ".markdown": async (bytes) => parseMarkdown(bytes.toString("utf8")),
  ".pdf": (bytes) => parsePdf(bytes),
};

async function fetchLocalFile(source: LocalFileSource): Promise<FetchedSource> {
  const file = process.env[source.pathEnv]?.trim();
  if (!file) {
    throw new Error(
      `${source.pathEnv} is not set. Point it at a downloaded copy of the document (never commit it).`,
    );
  }
  const absolute = path.resolve(file);
  const parse = PARSERS[path.extname(absolute).toLowerCase()];
  if (!parse) {
    throw new Error(
      `Can't parse ${absolute}: only Markdown (.md) and PDF (.pdf) local files are supported`,
    );
  }
  let bytes: Buffer;
  let modified: Date;
  try {
    [bytes, modified] = await Promise.all([
      readFile(absolute),
      stat(absolute).then((s) => s.mtime),
    ]);
  } catch (cause) {
    throw new Error(`Can't read ${absolute} (from ${source.pathEnv})`, { cause });
  }
  return {
    changeMarker: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    updatedAt: modified,
    url: pathToFileURL(absolute).href,
    load: () => parse(bytes),
  };
}

export function fetchSource(source: SourceConfig): Promise<FetchedSource> {
  switch (source.kind) {
    case "local-file":
      return fetchLocalFile(source);
  }
}
