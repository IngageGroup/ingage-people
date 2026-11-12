import PageHeader from "@/components/PageHeader";
import NotesPanel from "./NotesPanel";

export default function WelcomePage() {
  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-10">
      <PageHeader title="Welcome">
        This app was created from the Ingage bench web template. It comes with Microsoft Entra
        sign-in, the Ingage design system, Postgres through Drizzle, unit and end-to-end tests, and
        CI/CD to Azure. The README explains how to rename it, run it locally and deploy it. The
        notes below are a working example of a database-backed feature to copy or delete.
      </PageHeader>
      <NotesPanel />
    </main>
  );
}
