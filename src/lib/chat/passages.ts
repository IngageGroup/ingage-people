import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** A section of a source document that an answer may quote and cite. */
export interface Passage {
  /** Id Claude cites, e.g. "p1". Unique within one request. */
  id: string;
  sectionPath: string[];
  text: string;
  documentTitle: string;
  url: string;
  page?: number;
  /** ISO date of the source version. */
  lastUpdated: string;
}

/**
 * Finds the passages that may answer a question. Real retrieval (hybrid search and re-ranking,
 * #10 and #11) will be another implementation of this.
 */
export type PassageProvider = (question: string) => Promise<Passage[]>;

export const MAX_PASSAGES = 6;

const STOPWORDS = new Set(
  "the and for how what when where which who why much many does did are can you your about this that from have has with into there their our get any all how's what's".split(
    " ",
  ),
);

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 3 && !STOPWORDS.has(word)),
  );
}

/**
 * Splits a Markdown document into passages: the `#` heading is the document title, and each
 * `##`/`###` section with text under it becomes one passage. Ids are assigned by `rankPassages`.
 */
export function parsePassagesMarkdown(
  markdown: string,
  source: { url: string; lastUpdated: string },
): Passage[] {
  const passages: Passage[] = [];
  let title = "";
  const headings: string[] = [];
  let body: string[] = [];

  function closeSection() {
    const text = body.join("\n").trim();
    if (headings.length > 0 && text) {
      passages.push({
        id: "",
        sectionPath: [...headings],
        text,
        documentTitle: title,
        url: source.url,
        lastUpdated: source.lastUpdated,
      });
    }
    body = [];
  }

  for (const line of markdown.split("\n")) {
    const heading = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
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
      headings.length = level - 2;
      headings.push(name);
    }
  }
  closeSection();
  return passages;
}

/** The passages sharing the most words with the question, numbered p1, p2, … */
export function rankPassages(passages: Passage[], question: string, limit: number): Passage[] {
  const asked = words(question);
  return passages
    .map((passage) => {
      const have = words(`${passage.sectionPath.join(" ")} ${passage.text}`);
      const score = [...asked].filter((word) => have.has(word)).length;
      return { passage, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ passage }, index) => ({ ...passage, id: `p${index + 1}` }));
}

async function readDevPassages(file: string): Promise<Passage[]> {
  const absolute = path.resolve(file);
  let markdown: string;
  let modified: Date;
  try {
    [markdown, modified] = await Promise.all([
      readFile(absolute, "utf8"),
      stat(absolute).then((s) => s.mtime),
    ]);
  } catch (cause) {
    throw new Error(`CHAT_DEV_PASSAGES_FILE can't be read: ${absolute}`, { cause });
  }
  return parsePassagesMarkdown(markdown, {
    url: pathToFileURL(absolute).href,
    lastUpdated: modified.toISOString().slice(0, 10),
  });
}

/**
 * Until retrieval exists: outside production, `CHAT_DEV_PASSAGES_FILE` names a local Markdown
 * file whose sections are searched by shared words. Otherwise there are no passages, so every
 * question gets a "don't know" answer.
 */
export function getPassageProvider(): PassageProvider {
  const file = process.env["CHAT_DEV_PASSAGES_FILE"]?.trim();
  if (!file || process.env["NODE_ENV"] === "production") return async () => [];
  return async (question) => rankPassages(await readDevPassages(file), question, MAX_PASSAGES);
}
