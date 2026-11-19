import { describe, expect, it, vi } from "vitest";
import { makePdf } from "@/knowledge/pdf-fixture";
import { GRAPH_BASE, GraphError } from "@/lib/graph/client";
import { readFile, searchFiles } from "@/lib/graph/files";
import { TOOL_TEXT_MAX } from "@/lib/graph/m365-item";

type Route = (url: string, init: RequestInit) => Response | undefined;

function router(...routes: Route[]) {
  return vi.fn(async (url: string, init: RequestInit) => {
    for (const route of routes) {
      const response = route(url, init);
      if (response) return response;
    }
    throw new Error(`unexpected request ${url}`);
  });
}

/** A Response over a copy of the PDF bytes (a plain ArrayBuffer, as fetch bodies need). */
const pdfResponse = (pdf: Uint8Array) => new Response(pdf.slice().buffer as ArrayBuffer);

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function searchHits(hits: unknown[]) {
  return { value: [{ hitsContainers: [{ hits }] }] };
}

function metadata(name: string) {
  return {
    name,
    webUrl: `https://ingage.sharepoint.com/${name}`,
    lastModifiedDateTime: "2026-11-10T12:00:00Z",
    parentReference: { driveId: "d1", path: "/drive/root:/Clients/Acme" },
  };
}

describe("searchFiles", () => {
  const hit = (id: string, name: string) => ({
    hitId: id,
    summary: "The <c0>deadline</c0> moved to Friday <ddd/>",
    resource: {
      id,
      name,
      webUrl: `https://ingage.sharepoint.com/${name}`,
      lastModifiedDateTime: "2026-11-10T12:00:00Z",
      parentReference: { driveId: "d1" },
    },
  });

  it("maps hits to items with a drive/item ref and the snippet as text", async () => {
    const fetchFn = router((url) =>
      url === `${GRAPH_BASE}/search/query` ? json(searchHits([hit("i1", "plan.docx")])) : undefined,
    );
    const [item] = await searchFiles("deadline", "tok", fetchFn);
    expect(item).toMatchObject({
      kind: "file",
      ref: "d1/i1",
      title: "plan.docx",
      url: "https://ingage.sharepoint.com/plan.docx",
      lastModified: "2026-11-10T12:00:00Z",
      text: "The deadline moved to Friday …",
    });
    expect(item?.location.length).toBeGreaterThan(0);
  });

  it("sends the query only in the POST body", async () => {
    const fetchFn = router(() => json(searchHits([])));
    await searchFiles("secret project", "tok", fetchFn);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${GRAPH_BASE}/search/query`);
    expect(init.method).toBe("POST");
    expect(String(init.body)).toContain("secret project");
    expect(JSON.parse(String(init.body)).requests[0].entityTypes).toEqual(["driveItem"]);
  });

  it("uses the hit id when the resource has none, and skips hits without a drive", async () => {
    const noId = {
      ...hit("i2", "a.pdf"),
      resource: { ...hit("i2", "a.pdf").resource, id: undefined },
    };
    const noDrive = {
      ...hit("i3", "b.pdf"),
      resource: { ...hit("i3", "b.pdf").resource, parentReference: {} },
    };
    const items = await searchFiles(
      "x",
      "tok",
      router(() => json(searchHits([noId, noDrive]))),
    );
    expect(items.map((i) => i.ref)).toEqual(["d1/i2"]);
  });

  it("returns nothing when there are no hits", async () => {
    expect(
      await searchFiles(
        "x",
        "tok",
        router(() => json({ value: [{ hitsContainers: [{}] }] })),
      ),
    ).toEqual([]);
  });
});

describe("readFile", () => {
  const meta =
    (name: string): Route =>
    (url) =>
      url.startsWith(`${GRAPH_BASE}/drives/d1/items/i1?`) ? json(metadata(name)) : undefined;

  it("converts an Office file to PDF and returns its text", async () => {
    const pdf = makePdf([
      [
        { text: "Project Notes", x: 72, y: 740, size: 20 },
        { text: "Kickoff is on Monday.", x: 72, y: 700, size: 11 },
      ],
    ]);
    const fetchFn = router(meta("notes.docx"), (url) =>
      url === `${GRAPH_BASE}/drives/d1/items/i1/content?format=pdf` ? pdfResponse(pdf) : undefined,
    );
    const item = await readFile("d1/i1", "tok", fetchFn);
    expect(item).toMatchObject({ kind: "file", ref: "d1/i1", title: "notes.docx" });
    expect(item.text).toContain("# Project Notes");
    expect(item.text).toContain("Kickoff is on Monday.");
  });

  it("reads a PDF without conversion", async () => {
    const pdf = makePdf([
      [
        { text: "Budget 2027", x: 72, y: 740, size: 20 },
        { text: "Budget approved.", x: 72, y: 700, size: 11 },
      ],
    ]);
    const fetchFn = router(meta("budget.pdf"), (url) =>
      url === `${GRAPH_BASE}/drives/d1/items/i1/content` ? pdfResponse(pdf) : undefined,
    );
    expect((await readFile("d1/i1", "tok", fetchFn)).text).toContain("Budget approved.");
  });

  it("reads Markdown as text", async () => {
    const fetchFn = router(meta("README.md"), (url) =>
      url === `${GRAPH_BASE}/drives/d1/items/i1/content`
        ? new Response("# Setup\nRun it.")
        : undefined,
    );
    expect((await readFile("d1/i1", "tok", fetchFn)).text).toBe("# Setup\nRun it.");
  });

  it("cuts long text and says so", async () => {
    const fetchFn = router(meta("big.txt"), (url) =>
      url.endsWith("/content") ? new Response("a".repeat(30_000)) : undefined,
    );
    const { text } = await readFile("d1/i1", "tok", fetchFn);
    expect(text.startsWith("a".repeat(TOOL_TEXT_MAX))).toBe(true);
    expect(text).not.toContain("a".repeat(TOOL_TEXT_MAX + 1));
    expect(text).toMatch(/\[cut: the rest of this item is not shown\]$/);
  });

  it("says when a PDF has no text layer instead of failing the answer", async () => {
    const fetchFn = router(meta("scan.pdf"), (url) =>
      url.endsWith("/content") ? pdfResponse(makePdf([[]])) : undefined,
    );
    expect((await readFile("d1/i1", "tok", fetchFn)).text).toBe(
      "This file has no readable text (it may be a scan).",
    );
  });

  it("says a file type can't be read without downloading it", async () => {
    const fetchFn = router(meta("archive.zip"));
    const item = await readFile("d1/i1", "tok", fetchFn);
    expect(item.text).toBe("This file type can't be read.");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("throws not-found when Graph has no such item", async () => {
    const fetchFn = router(() => json({ error: { code: "itemNotFound" } }, 404));
    await expect(readFile("d1/i1", "tok", fetchFn)).rejects.toBeInstanceOf(GraphError);
    await expect(readFile("d1/i1", "tok", fetchFn)).rejects.toMatchObject({ failure: "not-found" });
  });

  it("rejects a malformed ref without calling Graph", async () => {
    const fetchFn = router();
    await expect(readFile("no-slash", "tok", fetchFn)).rejects.toThrow(/Unknown file reference/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
