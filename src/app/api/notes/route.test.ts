import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ getCurrentUserEmail: vi.fn() }));
vi.mock("@/db/notes", () => ({ listNotes: vi.fn(), createNote: vi.fn() }));

import { createNote, listNotes } from "@/db/notes";
import { getCurrentUserEmail } from "@/lib/auth";
import { GET, POST } from "./route";

const note = {
  id: "8c0e6a52-6b1f-4d8e-9a39-2f7c1f8f1a11",
  title: "hi",
  createdBy: "a@x.com",
  createdAt: new Date("2026-11-11T12:00:00Z"),
};

function post(body: string): Request {
  return new Request("http://localhost/api/notes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(getCurrentUserEmail).mockResolvedValue("a@x.com");
});

describe("GET /api/notes", () => {
  it("returns the notes", async () => {
    vi.mocked(listNotes).mockResolvedValue([note]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      notes: [{ ...note, createdAt: "2026-11-11T12:00:00.000Z" }],
    });
  });

  it("returns 500 with a correlation id and logs it when the database fails", async () => {
    vi.mocked(listNotes).mockRejectedValue(new Error("connection refused"));
    const res = await GET();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Database error");
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(body.correlationId),
      expect.any(Error),
    );
  });
});

describe("POST /api/notes", () => {
  it("creates a note owned by the signed-in user, ignoring created_by in the body", async () => {
    vi.mocked(createNote).mockResolvedValue(note);
    const res = await POST(post(JSON.stringify({ title: " hi ", created_by: "evil@x.com" })));
    expect(res.status).toBe(201);
    expect(createNote).toHaveBeenCalledWith({ title: "hi", createdBy: "a@x.com" });
    expect((await res.json()).note.title).toBe("hi");
  });

  it("returns 400 with the validation message for an empty title", async () => {
    const res = await POST(post(JSON.stringify({ title: "" })));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Title is required" });
    expect(createNote).not.toHaveBeenCalled();
  });

  it("returns 400 when the body is not JSON", async () => {
    const res = await POST(post("not json"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Request body must be JSON" });
  });

  it("returns 400 when the body is empty", async () => {
    const res = await POST(post(""));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Request body must be JSON" });
  });

  it("returns 401 without a signed-in user", async () => {
    vi.mocked(getCurrentUserEmail).mockResolvedValue(null);
    const res = await POST(post(JSON.stringify({ title: "hi" })));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(createNote).not.toHaveBeenCalled();
  });

  it("returns 500 when the insert fails", async () => {
    vi.mocked(createNote).mockRejectedValue(new Error("insert failed"));
    const res = await POST(post(JSON.stringify({ title: "hi" })));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Database error");
  });
});
