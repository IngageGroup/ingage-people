import { NextResponse } from "next/server";
import { createNote, listNotes } from "@/db/notes";
import { getCurrentUserEmail } from "@/lib/auth";
import { createNoteSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

function databaseError(operation: string, err: unknown): NextResponse {
  const correlationId = crypto.randomUUID().slice(0, 8);
  console.error(`[api/notes ${correlationId}] ${operation} failed`, err);
  return NextResponse.json({ error: "Database error", correlationId }, { status: 500 });
}

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json({ notes: await listNotes() });
  } catch (err) {
    return databaseError("list notes", err);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const email = await getCurrentUserEmail();
  if (!email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON" }, { status: 400 });
  }

  const parsed = createNoteSchema.safeParse(body);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Invalid request body";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    const note = await createNote({ title: parsed.data.title, createdBy: email });
    return NextResponse.json({ note }, { status: 201 });
  } catch (err) {
    return databaseError("create note", err);
  }
}
