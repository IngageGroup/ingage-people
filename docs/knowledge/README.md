# Knowledge docs

Markdown the chat answers from. Each folder here is one source in `src/knowledge/sources.ts`
(kind `repo-markdown`); every `.md` file in it becomes its own document, cited as
`/docs/<source id>/<file path without .md>`.

- File and folder names: lowercase letters, digits, and dashes (they become links).
- Start each file with one `#` title. `##` and deeper headings become the section path shown
  in citations, and chunks never span sections, so keep each section about one thing.
- The ingest re-embeds only files whose content changed and removes the sources of deleted
  files.

The Docker image includes this folder so the ingest job can read it. This README is not ingested.
