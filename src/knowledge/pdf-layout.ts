import type { DocumentSection, ParsedDocument } from "@/knowledge/document";

/** One run of text as the PDF draws it. Positions are in points from the bottom-left. */
export interface Fragment {
  text: string;
  x: number;
  y: number;
  width: number;
  size: number;
}

export interface Page {
  number: number;
  height: number;
  fragments: Fragment[];
}

interface Line {
  page: number;
  y: number;
  /** The font size most of the line's characters use. */
  size: number;
  fragments: Fragment[];
  text: string;
}

/** A stretch of a line separated from its neighbours by a wide gap: a table cell. */
interface Cell {
  text: string;
  left: number;
  right: number;
}

interface Table {
  rows: string[][];
  /** Index of the first line after the table. */
  end: number;
  page: number;
}

type Block =
  | { kind: "paragraph"; text: string }
  | { kind: "bullet"; text: string; nested: boolean }
  | { kind: "table"; rows: string[][]; page: number };

/** Measurements of the document's body text, used to judge every other line. */
interface Body {
  size: number;
  /** Usual distance between lines of a paragraph. */
  lineGap: number;
  /** Usual left edge of body text. */
  margin: number;
}

const LONE_BULLET = /^[•●▪‣∙◦o]$/;
const LEADING_BULLET = /^[•●▪‣∙◦]\s+/;
const NESTED_BULLET = /^[◦o]$/;
/** Headers and footers sit in the top and bottom 8% of the page. */
const MARGIN_BAND = 0.08;
/** A run of more same-size large lines than this is a paragraph, not a heading. */
const MAX_HEADING_LINES = 2;
/** Gap between fragments, in multiples of the font size, that separates table cells. */
const CELL_GAP = 1.5;

function mostCommon(values: number[]): number | undefined {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
}

function joinFragments(fragments: Fragment[]): string {
  let text = "";
  let end = Number.NEGATIVE_INFINITY;
  for (const f of fragments) {
    const touching = f.x - end <= 1 || /\s$/.test(text) || /^\s/.test(f.text);
    text += text && !touching ? ` ${f.text}` : f.text;
    end = f.x + f.width;
  }
  return text.replace(/\s+/g, " ").trim();
}

function dominantSize(fragments: Fragment[]): number {
  const chars = new Map<number, number>();
  for (const f of fragments) chars.set(f.size, (chars.get(f.size) ?? 0) + f.text.length);
  return [...chars].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
}

/** Groups a page's fragments into lines, top to bottom. Superscripts join their line. */
function pageLines(page: Page): Line[] {
  const sorted = [...page.fragments].sort((a, b) => b.y - a.y || a.x - b.x);
  const groups: Fragment[][] = [];
  for (const f of sorted) {
    const current = groups.at(-1);
    const anchor = current?.[0];
    if (current && anchor && Math.abs(anchor.y - f.y) < Math.max(anchor.size, f.size) / 2) {
      current.push(f);
    } else {
      groups.push([f]);
    }
  }
  return groups.map((group) => {
    const fragments = group.sort((a, b) => a.x - b.x);
    return {
      page: page.number,
      y: Math.max(...fragments.map((f) => f.y)),
      size: dominantSize(fragments),
      fragments,
      text: joinFragments(fragments),
    };
  });
}

/** Drops page numbers, and header/footer lines that repeat on at least half the pages. */
function stripRepeated(pages: Page[], linesByPage: Line[][]): Line[][] {
  const inBand = (line: Line, height: number) =>
    line.y < height * MARGIN_BAND || line.y > height * (1 - MARGIN_BAND);
  const key = (line: Line) => line.text.replace(/\d+/g, "#");
  const pagesWith = new Map<string, number>();
  linesByPage.forEach((lines, i) => {
    const height = pages[i]?.height ?? 0;
    for (const k of new Set(lines.filter((l) => inBand(l, height)).map(key))) {
      pagesWith.set(k, (pagesWith.get(k) ?? 0) + 1);
    }
  });
  const threshold = Math.max(2, linesByPage.length / 2);
  return linesByPage.map((lines, i) => {
    const height = pages[i]?.height ?? 0;
    return lines.filter(
      (line) =>
        !inBand(line, height) ||
        (!/^\d+$/.test(line.text) && (pagesWith.get(key(line)) ?? 0) < threshold),
    );
  });
}

/** Lines in a run of the same size, on one page, spaced like lines of one block. */
function runLength(lines: Line[], start: number): number {
  const first = lines[start];
  let end = start + 1;
  while (first) {
    const prev = lines[end - 1];
    const next = lines[end];
    if (!prev || !next || next.size !== first.size || next.page !== first.page) break;
    if (prev.y - next.y > first.size * 2) break;
    end++;
  }
  return end - start;
}

/** The first page's largest text, which is the cover title, and how many lines it spans. */
function findTitle(firstPage: Line[]): { title: string; lines: number } {
  const largest = Math.max(0, ...firstPage.map((l) => l.size));
  const start = firstPage.findIndex((l) => l.size === largest);
  if (start === -1) return { title: "", lines: 0 };
  const count = runLength(firstPage, start);
  const title = firstPage
    .slice(start, start + count)
    .map((l) => l.text)
    .join(" ");
  return { title, lines: count };
}

function measureBody(lines: Line[]): Body {
  const chars = new Map<number, number>();
  for (const l of lines) chars.set(l.size, (chars.get(l.size) ?? 0) + l.text.length);
  const size = [...chars].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  const bodyLines = lines.filter((l) => l.size === size);
  const gaps: number[] = [];
  for (let i = 1; i < bodyLines.length; i++) {
    const [prev, line] = [bodyLines[i - 1], bodyLines[i]];
    if (prev && line && prev.page === line.page) gaps.push(Math.round(prev.y - line.y));
  }
  const margin = mostCommon(bodyLines.map((l) => Math.round(l.fragments[0]?.x ?? 0))) ?? 0;
  return { size, lineGap: mostCommon(gaps.filter((g) => g > 0)) ?? size * 1.6, margin };
}

/** Heading text and level for each line index that starts a heading, by font size. */
function findHeadings(
  lines: Line[],
  body: Body,
): Map<number, { text: string; size: number; lines: number }> {
  const headings = new Map<number, { text: string; size: number; lines: number }>();
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    const count = runLength(lines, i);
    if (line && line.size > body.size && count <= MAX_HEADING_LINES) {
      const text = lines
        .slice(i, i + count)
        .map((l) => l.text)
        .join(" ");
      headings.set(i, { text, size: line.size, lines: count });
    }
    i += count;
  }
  return headings;
}

function cellsOf(line: Line): Cell[] {
  const cells: Cell[] = [];
  let group: Fragment[] = [];
  const close = () => {
    const first = group[0];
    const last = group.at(-1);
    if (first && last) {
      cells.push({ text: joinFragments(group), left: first.x, right: last.x + last.width });
    }
    group = [];
  };
  for (const f of line.fragments) {
    const prev = group.at(-1);
    const bullet = prev !== undefined && group.length === 1 && LONE_BULLET.test(prev.text.trim());
    if (prev && !bullet && f.x - (prev.x + prev.width) > line.size * CELL_GAP) close();
    group.push(f);
  }
  close();
  return cells;
}

/** Column spans: the x ranges covered by cells, merged where they overlap. */
function columnSpans(cells: Cell[]): { left: number; right: number }[] {
  const spans: { left: number; right: number }[] = [];
  for (const cell of [...cells].sort((a, b) => a.left - b.left)) {
    const last = spans.at(-1);
    if (last && cell.left <= last.right + 2) last.right = Math.max(last.right, cell.right);
    else spans.push({ left: cell.left, right: cell.right });
  }
  return spans;
}

/** Whether a line can't belong to the table: it bridges columns, or body text resumes. */
function endsTable(cells: Cell[], tableCells: Cell[], body: Body): boolean {
  const spans = columnSpans(tableCells);
  const firstColumnAtMargin = Math.abs((spans[0]?.left ?? 0) - body.margin) < 2;
  const only = cells.length === 1 ? cells[0] : undefined;
  if (only && !firstColumnAtMargin && Math.abs(only.left - body.margin) < 2) return true;
  return cells.some(
    (cell) => spans.filter((s) => cell.left < s.right && cell.right > s.left).length >= 2,
  );
}

/**
 * Groups table lines into rows. A line is cell text wrapping from the line above when it sits
 * at paragraph line spacing and other rows in the table are spaced wider; otherwise it starts
 * a row.
 */
function tableRows(lines: Line[], lineCells: Cell[][], body: Body): string[][] {
  const spans = columnSpans(lineCells.flat());
  const gaps = lines.slice(1).map((line, i) => (lines[i]?.y ?? 0) - line.y);
  const widest = Math.max(0, ...gaps);
  const wraps = (gap: number) => gap <= body.lineGap * 1.1 && gap < widest * 0.85;
  const rows: string[][] = [];
  lineCells.forEach((cells, i) => {
    if (i === 0 || !wraps(gaps[i - 1] ?? 0)) rows.push(spans.map(() => ""));
    const row = rows.at(-1) ?? [];
    for (const cell of cells) {
      const center = (cell.left + cell.right) / 2;
      const column = Math.max(
        0,
        spans.findIndex((s) => center >= s.left && center <= s.right),
      );
      row[column] = `${row[column] ?? ""} ${cell.text}`.trim();
    }
  });
  return rows;
}

/** A table starting at `start`: lines whose text sits in two or more aligned columns. */
function takeTable(lines: Line[], start: number, headings: Set<number>, body: Body): Table | null {
  const first = lines[start];
  const firstCells = first ? cellsOf(first) : [];
  if (!first || firstCells.length < 2) return null;
  const region = [first];
  const regionCells = [firstCells];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    const prev = region.at(-1);
    if (!line || !prev || headings.has(i) || line.page !== prev.page) break;
    if (prev.y - line.y > body.lineGap * 4) break;
    const cells = cellsOf(line);
    if (endsTable(cells, regionCells.flat(), body)) break;
    region.push(line);
    regionCells.push(cells);
  }
  if (columnSpans(regionCells.flat()).length < 2) return null;
  return {
    rows: tableRows(region, regionCells, body),
    end: start + region.length,
    page: first.page,
  };
}

function bulletOf(line: Line): { text: string; nested: boolean } | null {
  const [first, ...rest] = line.fragments;
  if (first && rest.length > 0 && LONE_BULLET.test(first.text.trim())) {
    return { text: joinFragments(rest), nested: NESTED_BULLET.test(first.text.trim()) };
  }
  return LEADING_BULLET.test(line.text)
    ? { text: line.text.replace(LEADING_BULLET, ""), nested: false }
    : null;
}

/** Whether a line continues the paragraph or bullet the previous line was part of. */
function continues(
  prev: Line | undefined,
  line: Line,
  last: Block | undefined,
  body: Body,
): boolean {
  if (!prev || !last || last.kind === "table") return false;
  if (line.page !== prev.page) return !/[.!?:]$/.test(last.text);
  return prev.y - line.y <= body.lineGap * 1.25;
}

function escapeCell(text: string): string {
  return text.replaceAll("|", "\\|");
}

function renderTable(rows: string[][]): string {
  const [header = [], ...rest] = rows;
  const line = (cells: string[]) => `| ${cells.map(escapeCell).join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rest.map(line)].join("\n");
}

function render(blocks: Block[]): string {
  let text = "";
  blocks.forEach((block, i) => {
    const prev = blocks[i - 1];
    if (prev) text += prev.kind === "bullet" && block.kind === "bullet" ? "\n" : "\n\n";
    if (block.kind === "table") text += renderTable(block.rows);
    else if (block.kind === "bullet") text += `${block.nested ? "  " : ""}- ${block.text}`;
    else text += block.text;
  });
  return text;
}

/** Builds sections from content lines: headings open sections, everything else fills them. */
class SectionBuilder {
  readonly sections: DocumentSection[] = [];
  private readonly stack: { text: string; size: number }[] = [];
  private blocks: Block[] = [];
  private page: number | undefined;
  private prev: Line | undefined;

  constructor(private readonly body: Body) {}

  heading(text: string, size: number): void {
    this.flush();
    while ((this.stack.at(-1)?.size ?? Number.POSITIVE_INFINITY) <= size) this.stack.pop();
    this.stack.push({ text, size });
    this.prev = undefined;
  }

  table(table: Table, lastLine: Line | undefined): void {
    this.page ??= table.page;
    const last = this.blocks.at(-1);
    const sameShape = last?.kind === "table" && last.rows[0]?.length === table.rows[0]?.length;
    if (last?.kind === "table" && sameShape && last.page !== table.page) {
      last.rows.push(...table.rows);
      last.page = table.page;
    } else {
      this.blocks.push({ kind: "table", rows: table.rows, page: table.page });
    }
    this.prev = lastLine;
  }

  line(line: Line): void {
    this.page ??= line.page;
    const bullet = bulletOf(line);
    const last = this.blocks.at(-1);
    if (bullet) this.blocks.push({ kind: "bullet", ...bullet });
    else if (last && last.kind !== "table" && continues(this.prev, line, last, this.body)) {
      last.text = `${last.text} ${line.text}`;
    } else this.blocks.push({ kind: "paragraph", text: line.text });
    this.prev = line;
  }

  flush(): void {
    const text = render(this.blocks).trim();
    if (text) {
      const section: DocumentSection = { headingPath: this.stack.map((h) => h.text), text };
      if (this.page !== undefined) section.page = this.page;
      this.sections.push(section);
    }
    this.blocks = [];
    this.page = undefined;
  }
}

/**
 * Turns positioned text into sections. Lines larger than the body text are headings, nested
 * by size; text in aligned columns becomes Markdown tables; bullets become a Markdown list.
 * Pages before `firstContentPage` are skipped; the first page's largest text is the title.
 */
export function layoutDocument(pages: Page[], firstContentPage: number): ParsedDocument {
  const linesByPage = stripRepeated(pages, pages.map(pageLines));
  const { title, lines: titleLines } = findTitle(linesByPage[0] ?? []);
  const content = linesByPage.slice(firstContentPage - 1).flat();
  if (firstContentPage === 1) {
    const start = content.findIndex((l) => l.page === 1 && title.startsWith(l.text));
    if (start !== -1) content.splice(start, titleLines);
  }

  const body = measureBody(content);
  const headings = findHeadings(content, body);
  const headingStarts = new Set(headings.keys());
  const builder = new SectionBuilder(body);
  for (let i = 0; i < content.length; ) {
    const heading = headings.get(i);
    const table = heading ? null : takeTable(content, i, headingStarts, body);
    if (heading) {
      builder.heading(heading.text, heading.size);
      i += heading.lines;
    } else if (table) {
      builder.table(table, content[table.end - 1]);
      i = table.end;
    } else {
      const line = content[i];
      if (line) builder.line(line);
      i++;
    }
  }
  builder.flush();
  return { title, sections: builder.sections };
}
