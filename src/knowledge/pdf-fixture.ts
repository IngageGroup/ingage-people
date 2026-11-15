/** A piece of text drawn at a position, in PDF points from the bottom-left corner. */
export interface FixtureText {
  text: string;
  x: number;
  y: number;
  size: number;
}

export interface FixtureOutlineItem {
  title: string;
  /** 1-based page the bookmark points at. */
  page: number;
}

/** Escapes a PDF string; "•" becomes its WinAnsi code (octal 225). */
function escapePdfText(text: string): string {
  return text.replace(/[\\()]/g, (c) => `\\${c}`).replaceAll("•", "\\225");
}

function pageContent(items: FixtureText[]): string {
  return items
    .map((t) => `BT /F1 ${t.size} Tf 1 0 0 1 ${t.x} ${t.y} Tm (${escapePdfText(t.text)}) Tj ET`)
    .join("\n");
}

/**
 * Builds a minimal PDF for parser tests: US Letter pages of positioned Helvetica text and an
 * optional flat outline (bookmarks). Test-only; never used on real documents.
 */
export function makePdf(pages: FixtureText[][], outline: FixtureOutlineItem[] = []): Uint8Array {
  const objects: string[] = [];
  /** Appends an object and returns its object number. */
  const add = (body: string) => objects.push(body);

  const catalog = add("");
  const pagesId = add("");
  const font = add(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  );
  const pageIds: number[] = [];
  for (const items of pages) {
    const content = pageContent(items);
    const contentId = add(
      `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
    );
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`,
      ),
    );
  }
  objects[pagesId - 1] =
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

  let outlines = "";
  if (outline.length > 0) {
    const rootId = add("");
    const itemIds = outline.map(() => add(""));
    outline.forEach((item, i) => {
      const links = [
        i > 0 ? `/Prev ${itemIds[i - 1]} 0 R` : "",
        i < outline.length - 1 ? `/Next ${itemIds[i + 1]} 0 R` : "",
      ].join(" ");
      objects[(itemIds[i] ?? 0) - 1] =
        `<< /Title (${escapePdfText(item.title)}) /Parent ${rootId} 0 R ${links} /Dest [${pageIds[item.page - 1]} 0 R /XYZ 0 792 0] >>`;
    });
    objects[rootId - 1] =
      `<< /Type /Outlines /First ${itemIds[0]} 0 R /Last ${itemIds.at(-1)} 0 R /Count ${itemIds.length} >>`;
    outlines = ` /Outlines ${rootId} 0 R`;
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R${outlines} >>`;

  let pdf = "%PDF-1.7\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, "latin1"));
}
