import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, getPool } from "@/db";
import { getActiveVersion } from "@/db/knowledge";
import { EMBEDDING_DIMENSIONS, knowledgeSources } from "@/db/schema";
import { ingestSource } from "@/knowledge/ingest";
import { makePdf } from "@/knowledge/pdf-fixture";
import type { LocalFileSource } from "@/knowledge/sources";

const HANDBOOK = `# Test Handbook

## Time Off

### Paid Time Off

Request PTO two weeks ahead.

## Learning

Each employee has a training budget.
`;

let source: LocalFileSource;
let file: string;

const embed = vi.fn(async (texts: string[]) =>
  texts.map(() => Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.5)),
);
const log = vi.fn();

beforeEach(() => {
  file = path.join(mkdtempSync(path.join(tmpdir(), "ingest-")), "handbook.md");
  writeFileSync(file, HANDBOOK);
  const pathEnv = `TEST_HANDBOOK_PATH_${randomUUID().replaceAll("-", "_")}`;
  vi.stubEnv(pathEnv, file);
  source = {
    id: `test-${randomUUID()}`,
    topic: "handbook",
    kind: "local-file",
    audience: "everyone",
    pathEnv,
  };
});

afterEach(async () => {
  vi.unstubAllEnvs();
  embed.mockClear();
  log.mockClear();
  await getDb().delete(knowledgeSources).where(eq(knowledgeSources.id, source.id));
});

afterAll(async () => {
  await getPool().end();
});

async function storedChunks(versionId: string) {
  const result = await getDb().execute<{
    text: string;
    section_path: string[];
    url: string;
    dims: number;
    has_search: boolean;
  }>(sql`select text, section_path, url, vector_dims(embedding) as dims,
           search is not null and search <> ''::tsvector as has_search
         from knowledge_chunks where version_id = ${versionId} order by position`);
  return result.rows;
}

describe("ingestSource", () => {
  it("stores the file's chunks with embeddings and search vectors", async () => {
    const result = await ingestSource(source, { embed, log });

    expect(result).toMatchObject({ status: "stored", chunks: 2 });
    const active = await getActiveVersion(source.id);
    expect(active?.id).toBe(result.status === "stored" ? result.versionId : "");
    const chunks = await storedChunks(active?.id ?? "");
    expect(chunks).toEqual([
      {
        text: "Request PTO two weeks ahead.",
        section_path: ["Time Off", "Paid Time Off"],
        url: expect.stringMatching(/^file:\/\/.*handbook\.md$/),
        dims: EMBEDDING_DIMENSIONS,
        has_search: true,
      },
      expect.objectContaining({ text: "Each employee has a training budget." }),
    ]);
    expect(embed).toHaveBeenCalledWith([
      "Test Handbook > Time Off > Paid Time Off\n\nRequest PTO two weeks ahead.",
      "Test Handbook > Learning\n\nEach employee has a training budget.",
    ]);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/stored version .*: 2 chunks/));
  });

  it("does nothing when the file hasn't changed", async () => {
    const first = await ingestSource(source, { embed, log });
    embed.mockClear();

    const second = await ingestSource(source, { embed, log });

    expect(second).toEqual({ status: "unchanged", sourceId: source.id });
    expect(embed).not.toHaveBeenCalled();
    expect((await getActiveVersion(source.id))?.id).toBe(
      first.status === "stored" ? first.versionId : "",
    );
  });

  it("re-ingests an unchanged file with force", async () => {
    const first = await ingestSource(source, { embed, log });
    const second = await ingestSource(source, { embed, log, force: true });

    expect(second.status).toBe("stored");
    expect(second).not.toEqual(first);
  });

  it("re-ingests when the file changes", async () => {
    await ingestSource(source, { embed, log });
    writeFileSync(file, `${HANDBOOK}\n## Reviews\n\nTwice a year.\n`);

    expect(await ingestSource(source, { embed, log })).toMatchObject({ chunks: 3 });
  });

  it("keeps the previous version when embedding fails", async () => {
    const first = await ingestSource(source, { embed, log });
    writeFileSync(file, `${HANDBOOK}\n## Reviews\n\nTwice a year.\n`);
    embed.mockRejectedValueOnce(new Error("Voyage down"));

    await expect(ingestSource(source, { embed, log })).rejects.toThrow("Voyage down");
    expect((await getActiveVersion(source.id))?.id).toBe(
      first.status === "stored" ? first.versionId : "",
    );
  });

  it("explains a missing path variable", async () => {
    vi.stubEnv(source.pathEnv, "");
    await expect(ingestSource(source, { embed, log })).rejects.toThrow(
      `${source.pathEnv} is not set`,
    );
  });

  it("ingests a PDF, citing each chunk's page", async () => {
    const pdf = path.join(path.dirname(file), "handbook.pdf");
    writeFileSync(
      pdf,
      makePdf([
        [{ text: "Employee Handbook", x: 195, y: 400, size: 24 }],
        [
          { text: "Paid Time Off", x: 57, y: 740, size: 16 },
          {
            text: "Apprentices get three weeks of PTO each calendar year.",
            x: 57,
            y: 700,
            size: 11,
          },
        ],
      ]),
    );
    vi.stubEnv(source.pathEnv, pdf);

    const result = await ingestSource(source, { embed, log });

    const chunks = await storedChunks(result.status === "stored" ? result.versionId : "");
    expect(chunks).toEqual([
      expect.objectContaining({
        text: "Apprentices get three weeks of PTO each calendar year.",
        section_path: ["Paid Time Off"],
        url: expect.stringMatching(/^file:\/\/.*handbook\.pdf#page=2$/),
      }),
    ]);
    expect(embed).toHaveBeenCalledWith([
      "Employee Handbook > Paid Time Off\n\nApprentices get three weeks of PTO each calendar year.",
    ]);
  });

  it("rejects a file type it can't parse", async () => {
    const docx = path.join(path.dirname(file), "handbook.docx");
    writeFileSync(docx, "PK");
    vi.stubEnv(source.pathEnv, docx);
    await expect(ingestSource(source, { embed, log })).rejects.toThrow(
      "only Markdown (.md) and PDF (.pdf) local files are supported",
    );
  });
});
