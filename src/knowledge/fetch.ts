import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ParsedDocument } from "@/knowledge/document";
import { parseMarkdown } from "@/knowledge/markdown";
import { parsePdf } from "@/knowledge/pdf";
import type { LocalFileSource, RepoMarkdownSource } from "@/knowledge/sources";

/** One file from a repo Markdown folder, ingested as its own source. */
export interface RepoMarkdownFile {
  id: string;
  topic: string;
  kind: "repo-markdown-file";
  audience: "everyone";
  file: string;
  url: string;
}

/** A source that holds exactly one document. */
export type DocumentSource = LocalFileSource | RepoMarkdownFile;

/** Lowercase path segments with dashes: the file's path becomes part of a link. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;

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

async function fetchRepoMarkdownFile(source: RepoMarkdownFile): Promise<FetchedSource> {
  let bytes: Buffer;
  let modified: Date;
  try {
    [bytes, modified] = await Promise.all([
      readFile(source.file),
      stat(source.file).then((s) => s.mtime),
    ]);
  } catch (cause) {
    throw new Error(`Can't read ${source.file} (source ${source.id})`, { cause });
  }
  return {
    changeMarker: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    updatedAt: modified,
    url: source.url,
    load: async () => parseMarkdown(bytes.toString("utf8")),
  };
}

export function fetchSource(source: DocumentSource): Promise<FetchedSource> {
  switch (source.kind) {
    case "local-file":
      return fetchLocalFile(source);
    case "repo-markdown-file":
      return fetchRepoMarkdownFile(source);
  }
}

/**
 * The Markdown files in a repo folder (recursively), one source each, sorted by path. Fails if
 * the folder can't be read, holds no Markdown, or has a file name that can't be a link, so a
 * wrong path never looks like "every file was deleted".
 */
export async function listRepoMarkdown(source: RepoMarkdownSource): Promise<RepoMarkdownFile[]> {
  const dir = path.resolve(source.dir);
  let entries: string[];
  try {
    entries = await readdir(dir, { recursive: true });
  } catch (cause) {
    throw new Error(`Can't read ${dir} (source ${source.id})`, { cause });
  }
  const files = entries
    .map((entry) => entry.split(path.sep).join("/"))
    .filter((entry) => entry.toLowerCase().endsWith(".md"))
    .sort();
  if (files.length === 0) throw new Error(`No Markdown files in ${dir} (source ${source.id})`);
  return files.map((relative) => {
    const slug = relative.slice(0, -".md".length);
    if (!SLUG.test(slug)) {
      throw new Error(
        `File name "${relative}" in ${dir} must be lowercase letters, digits, and dashes`,
      );
    }
    return {
      id: `${source.id}/${slug}`,
      topic: source.topic,
      kind: "repo-markdown-file",
      audience: source.audience,
      file: path.join(dir, relative),
      url: `/docs/${source.id}/${slug}`,
    };
  });
}
