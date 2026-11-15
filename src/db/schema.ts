import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
  vector,
} from "drizzle-orm/pg-core";

export const notes = pgTable("notes", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: varchar("title", { length: 200 }).notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Note = typeof notes.$inferSelect;

/** Voyage 4 models' default size. All Voyage 4 models share one embedding space. */
export const EMBEDDING_DIMENSIONS = 1024;

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

/**
 * One configured knowledge source (the handbook, an onboarding doc set). Rows are upserted
 * from the source config in code on each ingest.
 */
export const knowledgeSources = pgTable("knowledge_sources", {
  id: text("id").primaryKey(),
  topic: text("topic").notNull(),
  kind: text("kind").notNull(),
  /** Who may see answers from this source. Only "everyone" is used so far. */
  audience: text("audience").notNull(),
  activeVersionId: uuid("active_version_id").references((): AnyPgColumn => knowledgeVersions.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const knowledgeVersionStatus = pgEnum("knowledge_version_status", [
  "active",
  "replaced",
  "failed",
]);

/** One ingest of a source. Kept after it's replaced; only its chunks are deleted. */
export const knowledgeVersions = pgTable(
  "knowledge_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: text("source_id")
      .notNull()
      .references(() => knowledgeSources.id, { onDelete: "cascade" }),
    /** The document's own title, shown with answers. */
    title: text("title").notNull(),
    /** SharePoint eTag or lastModifiedDateTime, or a content hash. */
    changeMarker: text("change_marker").notNull(),
    /** When the document itself was last updated, shown with answers. */
    documentUpdatedAt: timestamp("document_updated_at", { withTimezone: true }).notNull(),
    status: knowledgeVersionStatus("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("knowledge_versions_source_id_idx").on(t.sourceId)],
);

export const knowledgeChunks = pgTable(
  "knowledge_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    versionId: uuid("version_id")
      .notNull()
      .references(() => knowledgeVersions.id, { onDelete: "cascade" }),
    /** Order within the document. */
    position: integer("position").notNull(),
    text: text("text").notNull(),
    /** Heading path, e.g. ["Benefits", "Training Budget"]. */
    sectionPath: jsonb("section_path").$type<string[]>().notNull(),
    page: integer("page"),
    /** Deep link back to the document. */
    url: text("url").notNull(),
    // jsonb, not text[]: to_tsvector(regconfig, jsonb) is immutable, so it can be generated.
    search: tsvector("search")
      .notNull()
      .generatedAlwaysAs(
        sql`setweight(to_tsvector('english'::regconfig, section_path), 'A') || setweight(to_tsvector('english'::regconfig, text), 'B')`,
      ),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
  },
  (t) => [
    index("knowledge_chunks_version_id_idx").on(t.versionId),
    index("knowledge_chunks_search_idx").using("gin", t.search),
    index("knowledge_chunks_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);
