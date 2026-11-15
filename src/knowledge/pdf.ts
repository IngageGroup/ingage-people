import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import type { ParsedDocument } from "@/knowledge/document";
import { type Fragment, layoutDocument, type Page } from "@/knowledge/pdf-layout";

async function openPdf(task: PDFDocumentLoadingTask): Promise<PDFDocumentProxy> {
  try {
    return await task.promise;
  } catch (cause) {
    throw new Error("Can't read the PDF: it's damaged, encrypted, or not a PDF", { cause });
  }
}

async function readPages(doc: PDFDocumentProxy): Promise<Page[]> {
  const pages: Page[] = [];
  for (let number = 1; number <= doc.numPages; number++) {
    const page = await doc.getPage(number);
    const content = await page.getTextContent();
    const fragments: Fragment[] = [];
    for (const item of content.items) {
      if (!("str" in item) || !item.str.trim()) continue;
      const [, , , scale = 0, x = 0, y = 0] = item.transform as number[];
      fragments.push({
        text: item.str,
        x,
        y,
        width: item.width,
        size: Math.round(Math.abs(scale)),
      });
    }
    pages.push({ number, height: page.view[3] ?? 792, fragments });
  }
  return pages;
}

/** The first page a top-level bookmark points at. Pages before it are the cover and contents. */
async function firstBookmarkedPage(doc: PDFDocumentProxy): Promise<number | undefined> {
  let first: number | undefined;
  for (const item of (await doc.getOutline()) ?? []) {
    const dest = typeof item.dest === "string" ? await doc.getDestination(item.dest) : item.dest;
    const target: unknown = dest?.[0];
    let index: number | undefined;
    if (typeof target === "number") index = target;
    else if (target && typeof target === "object" && "num" in target && "gen" in target) {
      index = await doc.getPageIndex(target as { num: number; gen: number });
    }
    if (index !== undefined) first = Math.min(first ?? index + 1, index + 1);
  }
  return first;
}

/**
 * Parses a PDF with a text layer into sections. Headings come from font size, tables from
 * text aligned in columns (as Markdown tables), and repeated headers, footers, and page
 * numbers are dropped. When the PDF has bookmarks, pages before the first one (cover and table
 * of contents) are skipped.
 */
export async function parsePdf(bytes: Uint8Array): Promise<ParsedDocument> {
  // pdf.js takes ownership of the buffer it's given, so it gets a copy.
  const task = getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  try {
    const doc = await openPdf(task);
    const [pages, firstContentPage] = await Promise.all([readPages(doc), firstBookmarkedPage(doc)]);
    if (pages.every((page) => page.fragments.length === 0)) {
      throw new Error("The PDF has no text to index; scanned documents need OCR first");
    }
    return layoutDocument(pages, firstContentPage ?? 1);
  } finally {
    await task.destroy();
  }
}
