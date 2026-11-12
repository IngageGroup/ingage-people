import { Client } from "pg";

/** Empties the notes table so each test starts from a known state. */
export async function resetNotes(): Promise<void> {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL is not set; it comes from .env.test");
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("TRUNCATE notes");
  } finally {
    await client.end();
  }
}
