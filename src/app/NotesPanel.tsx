"use client";

import {
  Button,
  Card,
  Input,
  TableListHeading,
  TableListLine,
  Toast,
} from "@ingagegroup/ingage-react";
import { useCallback, useEffect, useId, useState } from "react";
import EmptyState from "@/components/EmptyState";
import { NOTE_TITLE_MAX } from "@/lib/validation";

type NoteRow = { id: string; title: string; createdBy: string; createdAt: string };
type LoadState = { kind: "loading" } | { kind: "error" } | { kind: "ready"; notes: NoteRow[] };

const COLUMNS = [
  { label: "Title", width: "minmax(0, 3fr)" },
  { label: "Created By", width: "minmax(0, 2fr)" },
  { label: "Created At", width: "minmax(0, 2fr)" },
];
const COLUMN_WIDTHS = COLUMNS.map((column) => column.width);
const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function NotesTable({ notes }: { notes: NoteRow[] }) {
  if (notes.length === 0) {
    return (
      <EmptyState icon="database" title="No notes yet">
        Add the first one above. Notes are stored in the Postgres notes table.
      </EmptyState>
    );
  }
  return (
    <Card padding={0}>
      <TableListHeading columns={COLUMNS} />
      {notes.map((note) => (
        <TableListLine
          key={note.id}
          columns={COLUMN_WIDTHS}
          cells={[
            <span key="title" className="break-words">
              {note.title}
            </span>,
            <span key="by" className="break-words">
              {note.createdBy}
            </span>,
            DATE_FORMAT.format(new Date(note.createdAt)),
          ]}
        />
      ))}
    </Card>
  );
}

/** The notes sample: an add form and the list, both backed by /api/notes. */
export default function NotesPanel() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [title, setTitle] = useState("");
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);
  // Input only ties its <label> to the field when given an id.
  const titleId = useId();

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/notes", { cache: "no-store" });
      if (!res.ok) throw new Error(`GET /api/notes returned ${res.status}`);
      const data = (await res.json()) as { notes: NoteRow[] };
      setState({ kind: "ready", notes: data.notes });
    } catch (err) {
      console.error("[notes] load failed", err);
      setState({ kind: "error" });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function addNote() {
    if (submitting) return;
    setSubmitting(true);
    setFieldError(undefined);
    try {
      const res = await fetch("/api/notes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setFieldError(data.error ?? `Could not add the note (status ${res.status}).`);
        return;
      }
      setTitle("");
      await load();
    } catch (err) {
      console.error("[notes] add failed", err);
      setFieldError("Could not reach the server. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="flex flex-col gap-6">
      <h2 className="text-xl">Notes</h2>
      {/* No <form>: the library's Button renders <button> without type and would submit it. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="flex-1">
          <Input
            id={titleId}
            label="Title"
            value={title}
            maxLength={NOTE_TITLE_MAX}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void addNote();
            }}
            {...(fieldError ? { error: fieldError } : {})}
          />
        </div>
        <div className="sm:pt-7">
          <Button icon="plus" disabled={submitting} onClick={() => void addNote()}>
            Add Note
          </Button>
        </div>
      </div>
      {state.kind === "loading" && <p style={{ color: "var(--text-muted)" }}>Loading notes…</p>}
      {state.kind === "error" && (
        <Toast tone="error" title="Could not load notes." style={{ maxWidth: "none" }}>
          Check that the database is running and migrated, then reload the page.
        </Toast>
      )}
      {state.kind === "ready" && <NotesTable notes={state.notes} />}
    </section>
  );
}
