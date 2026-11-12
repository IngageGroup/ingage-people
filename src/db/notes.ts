import { desc } from "drizzle-orm";
import { getDb } from "@/db";
import { type Note, notes } from "@/db/schema";

const LIST_LIMIT = 100;

/** The most recent notes, newest first. */
export async function listNotes(): Promise<Note[]> {
  return getDb().select().from(notes).orderBy(desc(notes.createdAt)).limit(LIST_LIMIT);
}

export async function createNote(input: { title: string; createdBy: string }): Promise<Note> {
  const [note] = await getDb().insert(notes).values(input).returning();
  if (!note) throw new Error("Insert into notes returned no row");
  return note;
}
