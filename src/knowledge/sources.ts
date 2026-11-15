/** A file on the machine running the ingest, named by an env var. For developing before SharePoint access exists. */
export interface LocalFileSource {
  id: string;
  topic: string;
  kind: "local-file";
  /** Who may see answers from this source. Only "everyone" is used so far. */
  audience: "everyone";
  /** Env var holding the file's path. The file itself is never committed. */
  pathEnv: string;
}

export type SourceConfig = LocalFileSource;

/** Every source the ingest job keeps in the knowledge store. Changes go through PR review. */
export const SOURCES: SourceConfig[] = [
  {
    id: "handbook",
    topic: "handbook",
    kind: "local-file",
    audience: "everyone",
    pathEnv: "HANDBOOK_LOCAL_PATH",
  },
];
