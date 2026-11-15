import PageHeader from "@/components/PageHeader";
import NotesPanel from "./NotesPanel";

/** The template's database-backed sample. Removed with the rest of the Notes code in #18. */
export default function NotesPage() {
  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-10">
      <PageHeader title="Notes">
        A working example of a database-backed feature from the Ingage bench web template.
      </PageHeader>
      <NotesPanel />
    </main>
  );
}
