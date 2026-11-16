import { parseArgs } from "node:util";
import { getPool } from "@/db";
import { ingestConfigured } from "@/knowledge/ingest";
import { SOURCES } from "@/knowledge/sources";
import { DEFAULT_EMBED_MODEL, embedDocuments } from "@/knowledge/voyage";

const USAGE = "Usage: pnpm ingest [--source <id>] [--force]";

function selectSources(id: string | undefined) {
  if (!id) return SOURCES;
  const match = SOURCES.filter((source) => source.id === id);
  if (match.length === 0) {
    const known = SOURCES.map((source) => source.id).join(", ");
    throw new Error(`Unknown source "${id}". Known sources: ${known}`);
  }
  return match;
}

/** Ingests the selected sources one at a time. Returns false if any failed. */
async function run(argv: string[]): Promise<boolean> {
  const { values } = parseArgs({
    args: argv,
    options: { source: { type: "string" }, force: { type: "boolean", default: false } },
  });
  const sources = selectSources(values.source);
  const apiKey = process.env["VOYAGE_API_KEY"]?.trim();
  if (!apiKey) throw new Error("VOYAGE_API_KEY is not set");
  const model = process.env["VOYAGE_EMBED_MODEL"]?.trim() || DEFAULT_EMBED_MODEL;
  const embed = (texts: string[]) => embedDocuments(texts, { apiKey, model });

  let ok = true;
  for (const source of sources) {
    try {
      const results = await ingestConfigured(source, { embed, force: values.force });
      for (const result of results) {
        if (result.status !== "failed") continue;
        ok = false;
        console.error(
          `[ingest ${result.sourceId}] failed; the previous version stays active`,
          result.error,
        );
      }
    } catch (err) {
      ok = false;
      console.error(`[ingest ${source.id}] failed; the previous version stays active`, err);
    }
  }
  return ok;
}

try {
  process.exitCode = (await run(process.argv.slice(2))) ? 0 : 1;
} catch (err) {
  console.error(`[ingest] ${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
  process.exitCode = 1;
} finally {
  await getPool().end();
}
