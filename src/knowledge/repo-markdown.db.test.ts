import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { asc, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, getPool } from "@/db";
import { getActiveVersion } from "@/db/knowledge";
import { EMBEDDING_DIMENSIONS, knowledgeSources } from "@/db/schema";
import { ingestRepoMarkdown } from "@/knowledge/ingest";
import type { RepoMarkdownSource } from "@/knowledge/sources";

const ACCOUNTS = `# Accounts and Access

## GitHub

Ask the bench lead to add you to the IngageGroup organization.
`;

const AZURE = `# Azure Access

## Subscriptions

Request Contributor on the bench subscription.
`;

let source: RepoMarkdownSource;
let dir: string;

const embed = vi.fn(async (texts: string[]) =>
  texts.map(() => Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.5)),
);
const log = vi.fn();

function write(relative: string, text: string): void {
  const file = path.join(dir, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

async function storedSources() {
  return getDb()
    .select({ id: knowledgeSources.id, topic: knowledgeSources.topic, kind: knowledgeSources.kind })
    .from(knowledgeSources)
    .where(sql`starts_with(${knowledgeSources.id}, ${`${source.id}/`})`)
    .orderBy(asc(knowledgeSources.id));
}

async function chunkUrls(sourceId: string) {
  const result = await getDb().execute<{ url: string; section_path: string[] }>(
    sql`select c.url, c.section_path from knowledge_chunks c
        join knowledge_sources s on s.active_version_id = c.version_id
        where s.id = ${sourceId} order by c.position`,
  );
  return result.rows;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "repo-md-"));
  source = {
    id: `test-${randomUUID()}`,
    topic: "dev-onboarding",
    kind: "repo-markdown",
    audience: "everyone",
    dir,
  };
});

afterEach(async () => {
  embed.mockClear();
  log.mockClear();
  await getDb()
    .delete(knowledgeSources)
    .where(sql`starts_with(${knowledgeSources.id}, ${`${source.id}/`})`);
});

afterAll(async () => {
  await getPool().end();
});

describe("ingestRepoMarkdown", () => {
  it("stores each Markdown file as its own source, named and linked by its path", async () => {
    write("accounts.md", ACCOUNTS);
    write("azure/access.md", AZURE);
    write("notes.txt", "not Markdown");

    const results = await ingestRepoMarkdown(source, { embed, log });

    expect(results.map((r) => [r.sourceId, r.status])).toEqual([
      [`${source.id}/accounts`, "stored"],
      [`${source.id}/azure/access`, "stored"],
    ]);
    expect(await storedSources()).toEqual([
      { id: `${source.id}/accounts`, topic: "dev-onboarding", kind: "repo-markdown-file" },
      { id: `${source.id}/azure/access`, topic: "dev-onboarding", kind: "repo-markdown-file" },
    ]);
    expect(await getActiveVersion(`${source.id}/azure/access`)).toMatchObject({
      title: "Azure Access",
    });
    expect(await chunkUrls(`${source.id}/azure/access`)).toEqual([
      { url: `/docs/${source.id}/azure/access`, section_path: ["Subscriptions"] },
    ]);
  });

  it("re-embeds only the files that changed", async () => {
    write("accounts.md", ACCOUNTS);
    write("azure.md", AZURE);
    await ingestRepoMarkdown(source, { embed, log });
    embed.mockClear();

    write("azure.md", `${AZURE}\n## Regions\n\nUse East US 2.\n`);
    const results = await ingestRepoMarkdown(source, { embed, log });

    expect(results.map((r) => r.status)).toEqual(["unchanged", "stored"]);
    expect(embed).toHaveBeenCalledTimes(1);
  });

  it("removes the source and chunks of a deleted file", async () => {
    write("accounts.md", ACCOUNTS);
    write("azure.md", AZURE);
    await ingestRepoMarkdown(source, { embed, log });

    rmSync(path.join(dir, "azure.md"));
    const results = await ingestRepoMarkdown(source, { embed, log });

    expect(results).toContainEqual({ status: "removed", sourceId: `${source.id}/azure` });
    expect((await storedSources()).map((s) => s.id)).toEqual([`${source.id}/accounts`]);
    expect(await chunkUrls(`${source.id}/azure`)).toEqual([]);
  });

  it("keeps a file's previous version when it fails, and still stores the others", async () => {
    write("accounts.md", ACCOUNTS);
    write("azure.md", AZURE);
    await ingestRepoMarkdown(source, { embed, log });

    write("azure.md", "# Azure Access\n");
    write("accounts.md", `${ACCOUNTS}\n## Email\n\nYou get an Ingage mailbox.\n`);
    const results = await ingestRepoMarkdown(source, { embed, log });

    expect(results.map((r) => [r.sourceId, r.status])).toEqual([
      [`${source.id}/accounts`, "stored"],
      [`${source.id}/azure`, "failed"],
    ]);
    expect(await chunkUrls(`${source.id}/azure`)).toHaveLength(1);
  });

  it("fails without removing anything when the folder is missing", async () => {
    write("accounts.md", ACCOUNTS);
    await ingestRepoMarkdown(source, { embed, log });

    rmSync(dir, { recursive: true });
    await expect(ingestRepoMarkdown(source, { embed, log })).rejects.toThrow(
      `Can't read ${dir} (source ${source.id})`,
    );
    expect(await storedSources()).toHaveLength(1);
  });

  it("fails without removing anything when the folder has no Markdown files", async () => {
    write("accounts.md", ACCOUNTS);
    await ingestRepoMarkdown(source, { embed, log });

    rmSync(path.join(dir, "accounts.md"));
    await expect(ingestRepoMarkdown(source, { embed, log })).rejects.toThrow(
      `No Markdown files in ${dir} (source ${source.id})`,
    );
    expect(await storedSources()).toHaveLength(1);
  });

  it("rejects file names that can't be used in a link before storing anything", async () => {
    write("accounts.md", ACCOUNTS);
    write("Azure Setup.md", AZURE);
    await expect(ingestRepoMarkdown(source, { embed, log })).rejects.toThrow(
      `File name "Azure Setup.md" in ${dir} must be lowercase letters, digits, and dashes`,
    );
    expect(await storedSources()).toEqual([]);
  });
});
