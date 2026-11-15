import { describe, expect, it } from "vitest";
import { parsePdf } from "@/knowledge/pdf";
import { type FixtureText, makePdf } from "@/knowledge/pdf-fixture";

const LEFT = 57;
const BODY = 11;
const LINE = 18;

function at(text: string, x: number, y: number, size = BODY): FixtureText {
  return { text, x, y, size };
}

/** Body lines at the left margin, one line spacing apart, starting at y. */
function lines(y: number, ...texts: string[]): FixtureText[] {
  return texts.map((text, i) => at(text, LEFT, y - i * LINE));
}

function pageNumber(n: number): FixtureText {
  return at(String(n), 548, 48);
}

const titlePage = [at("Employee Handbook", 195, 400, 24), pageNumber(1)];

describe("parsePdf", () => {
  it("uses the first page's largest text as the title and skips pages before the outline", async () => {
    const pdf = makePdf(
      [
        titlePage,
        [...lines(740, "TABLE OF CONTENTS", "Foreword"), pageNumber(2)],
        [at("Foreword", LEFT, 740, 16), ...lines(700, "Welcome to the company."), pageNumber(3)],
      ],
      [{ title: "Foreword", page: 3 }],
    );
    const doc = await parsePdf(pdf);

    expect(doc.title).toBe("Employee Handbook");
    expect(doc.sections).toEqual([
      { headingPath: ["Foreword"], text: "Welcome to the company.", page: 3 },
    ]);
  });

  it("nests headings by font size and records the page each section starts on", async () => {
    const pdf = makePdf(
      [
        titlePage,
        [
          at("Ingage Addendum", 210, 740, 24),
          at("Holidays, Vacation & Leave", LEFT, 690, 16),
          at("Holidays", LEFT, 660, 12),
          ...lines(630, "Salaried employees get eight paid holidays."),
          pageNumber(2),
        ],
        [
          at("Paid Time Off (PTO)", LEFT, 740, 12),
          ...lines(710, "Apprentices get three weeks."),
          pageNumber(3),
        ],
      ],
      [{ title: "Ingage Addendum", page: 2 }],
    );
    const { sections } = await parsePdf(pdf);

    expect(sections).toEqual([
      {
        headingPath: ["Ingage Addendum", "Holidays, Vacation & Leave", "Holidays"],
        text: "Salaried employees get eight paid holidays.",
        page: 2,
      },
      {
        headingPath: ["Ingage Addendum", "Holidays, Vacation & Leave", "Paid Time Off (PTO)"],
        text: "Apprentices get three weeks.",
        page: 3,
      },
    ]);
  });

  it("joins a heading that wraps onto a second line", async () => {
    const pdf = makePdf([
      titlePage,
      [
        at("Discipline & Leaving Revision Collective and its Operating", LEFT, 740, 16),
        at("Companies", LEFT, 721, 16),
        ...lines(690, "Employees who leave give two weeks' notice to their Manager/Coach and HR."),
      ],
    ]);
    const { sections } = await parsePdf(pdf);
    expect(sections[0]?.headingPath).toEqual([
      "Discipline & Leaving Revision Collective and its Operating Companies",
    ]);
  });

  it("treats a paragraph set in a larger font as text, not a run of headings", async () => {
    const big = (text: string, y: number) => at(text, LEFT, y, 12);
    const pdf = makePdf([
      titlePage,
      [
        at("Thrive", LEFT, 740, 16),
        big("The Thrive Accelerator is a hands-on work program that", 710),
        big("gives work experience to those who are seeking a pathway", 690),
        big("into technology careers.", 670),
        ...lines(
          630,
          "Apprentices remain in the program for up to twelve months before they graduate and",
          "move into a consulting role, an hourly role, or a role with a client that hires them",
          "directly, depending on the work available when the program comes to an end.",
        ),
      ],
    ]);
    const { sections } = await parsePdf(pdf);
    expect(sections).toEqual([
      {
        headingPath: ["Thrive"],
        text: "The Thrive Accelerator is a hands-on work program that gives work experience to those who are seeking a pathway into technology careers.\n\nApprentices remain in the program for up to twelve months before they graduate and move into a consulting role, an hourly role, or a role with a client that hires them directly, depending on the work available when the program comes to an end.",
        page: 2,
      },
    ]);
  });

  it("joins wrapped lines into paragraphs, continues them across pages, and keeps paragraph breaks", async () => {
    const pdf = makePdf([
      titlePage,
      [
        at("Foreword", LEFT, 740, 16),
        ...lines(700, "First paragraph line one", "line two."),
        ...lines(640, "Second paragraph starts here and the employee is responsible for the"),
        pageNumber(2),
      ],
      [...lines(740, "contents of this handbook."), pageNumber(3)],
    ]);
    const { sections } = await parsePdf(pdf);
    expect(sections[0]?.text).toBe(
      "First paragraph line one line two.\n\nSecond paragraph starts here and the employee is responsible for the contents of this handbook.",
    );
  });

  it("strips page numbers and headers or footers repeated on every page", async () => {
    const footer = (n: number) => [
      pageNumber(n),
      at("Confidential - Revision Collective", LEFT, 30, 8),
    ];
    const header = at("Employee Handbook 2025", LEFT, 770, 8);
    const pdf = makePdf([
      titlePage,
      [
        header,
        at("Court Leave", LEFT, 740, 16),
        ...lines(700, "Court leave is paid."),
        ...footer(2),
      ],
      [header, ...lines(740, "Bring the summons."), ...footer(3)],
      [header, ...lines(740, "Tell your coach."), ...footer(4)],
    ]);
    const { sections } = await parsePdf(pdf);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.text).toBe(
      "Court leave is paid.\n\nBring the summons.\n\nTell your coach.",
    );
  });

  it("turns bullets into a Markdown list, including wrapped bullet text", async () => {
    const pdf = makePdf([
      titlePage,
      [
        at("Holidays", LEFT, 740, 16),
        ...lines(700, "Paid holidays:"),
        at("•", 75, 670),
        at("New Year's Day", 93, 670),
        at("•", 75, 650),
        at("Day after Thanksgiving or another desired", 93, 650),
        at("floating holiday", 93, 632),
        at("• Christmas Day", 75, 612),
      ],
    ]);
    const { sections } = await parsePdf(pdf);
    expect(sections[0]?.text).toBe(
      "Paid holidays:\n\n- New Year's Day\n- Day after Thanksgiving or another desired floating holiday\n- Christmas Day",
    );
  });

  it("turns a table into a Markdown table, merging cell text that wraps", async () => {
    const pdf = makePdf([
      titlePage,
      [
        at("Paid Time Off (PTO)", LEFT, 740, 16),
        ...lines(700, "PTO Allocation is based on your position with Ingage."),
        at("Title", 188, 660),
        at("PTO", 379, 660),
        at("Allocation", 379, 642),
        at("Apprentice*", 188, 618),
        at("3 weeks", 379, 618),
        at("Consulting staff", 188, 595),
        at("based on", 379, 595),
        at("utilization", 379, 577),
        at("Non-Billing Directors*", 188, 554),
        at("5 weeks", 379, 554),
        ...lines(
          520,
          "*PTO hours are allocated per calendar year and unused hours do not carry over.",
        ),
      ],
    ]);
    const { sections } = await parsePdf(pdf);
    expect(sections[0]?.text).toBe(
      [
        "PTO Allocation is based on your position with Ingage.",
        "",
        "| Title | PTO Allocation |",
        "| --- | --- |",
        "| Apprentice* | 3 weeks |",
        "| Consulting staff | based on utilization |",
        "| Non-Billing Directors* | 5 weeks |",
        "",
        "*PTO hours are allocated per calendar year and unused hours do not carry over.",
      ].join("\n"),
    );
  });

  it("continues a table that runs onto the next page", async () => {
    const pdf = makePdf([
      titlePage,
      [
        at("Benefits", LEFT, 740, 16),
        at("Benefit", 80, 700),
        at("Full-time", 300, 700),
        at("401(k)", 80, 670),
        at("Eligible", 300, 670),
        pageNumber(2),
      ],
      [at("Life Insurance", 80, 740), at("Available", 300, 740), pageNumber(3)],
    ]);
    const { sections } = await parsePdf(pdf);
    expect(sections[0]?.text).toBe(
      "| Benefit | Full-time |\n| --- | --- |\n| 401(k) | Eligible |\n| Life Insurance | Available |",
    );
  });

  it("escapes pipes inside table cells", async () => {
    const pdf = makePdf([
      titlePage,
      [
        at("Codes", LEFT, 740, 16),
        at("Code", 80, 700),
        at("Meaning", 300, 700),
        at("A|B", 80, 670),
        at("Either", 300, 670),
      ],
    ]);
    const { sections } = await parsePdf(pdf);
    expect(sections[0]?.text).toContain("| A\\|B | Either |");
  });

  it("keeps text before the first heading with an empty heading path", async () => {
    const pdf = makePdf([
      titlePage,
      [...lines(740, "Intro text."), at("Foreword", LEFT, 700, 16), ...lines(670, "Body.")],
    ]);
    const { sections } = await parsePdf(pdf);
    expect(sections.map((s) => s.headingPath)).toEqual([[], ["Foreword"]]);
  });

  it("accepts a Node Buffer, as readFile returns", async () => {
    const pdf = makePdf([
      titlePage,
      [at("Foreword", LEFT, 740, 16), ...lines(700, "Welcome to the company.")],
    ]);
    const { sections } = await parsePdf(Buffer.from(pdf));
    expect(sections).toHaveLength(1);
  });

  it("fails clearly on a file that isn't a PDF", async () => {
    await expect(parsePdf(new TextEncoder().encode("not a pdf"))).rejects.toThrow(
      "Can't read the PDF: it's damaged, encrypted, or not a PDF",
    );
  });

  it("fails clearly on an empty file", async () => {
    await expect(parsePdf(new Uint8Array())).rejects.toThrow("Can't read the PDF");
  });

  it("fails clearly on a PDF with no text, such as a scan", async () => {
    await expect(parsePdf(makePdf([[], []]))).rejects.toThrow(
      "The PDF has no text to index; scanned documents need OCR first",
    );
  });
});
