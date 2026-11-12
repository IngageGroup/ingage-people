import { z } from "zod";

export const NOTE_TITLE_MAX = 200;

export const createNoteSchema = z.object({
  title: z
    .string({ error: "Title must be text" })
    .trim()
    .min(1, "Title is required")
    .max(NOTE_TITLE_MAX, `Title must be ${NOTE_TITLE_MAX} characters or fewer`),
});

export type CreateNoteInput = z.infer<typeof createNoteSchema>;
