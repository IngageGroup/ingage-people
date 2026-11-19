import { describe, expect, it } from "vitest";
import { createMarkerFilter } from "@/lib/chat/markers";

function run(chunks: string[]): { text: string; ids: string[] } {
  const filter = createMarkerFilter();
  let text = "";
  for (const chunk of chunks) text += filter.push(chunk);
  text += filter.flush();
  return { text, ids: filter.citedIds() };
}

describe("createMarkerFilter", () => {
  it("passes text without markers through unchanged", () => {
    expect(run(["The budget is ", "set each year."])).toEqual({
      text: "The budget is set each year.",
      ids: [],
    });
  });

  it("removes a marker and records its passage id", () => {
    expect(run(["You get 15 days [p2]."])).toEqual({ text: "You get 15 days.", ids: ["p2"] });
  });

  it("handles a marker split across chunks", () => {
    expect(run(["Reviews are yearly [", "p1", "0]. Ask HR."])).toEqual({
      text: "Reviews are yearly. Ask HR.",
      ids: ["p10"],
    });
  });

  it("records each id once, in the order first cited", () => {
    expect(run(["A [p3][p1]. B [p3]."]).ids).toEqual(["p3", "p1"]);
  });

  it("keeps brackets that aren't markers", () => {
    expect(run(["Use [this form] or [p", "x]."]).text).toBe("Use [this form] or [px].");
  });

  it("releases a trailing partial marker at the end of the stream", () => {
    expect(run(["Ends with [p"]).text).toBe("Ends with [p");
  });

  it("doesn't hold back text after a closed bracket", () => {
    const filter = createMarkerFilter();
    expect(filter.push("Done [p1] and more")).toBe("Done and more");
  });

  it("removes Microsoft 365 item markers and records their ids", () => {
    expect(run(["Yes [m2] and [t1]. See the file [f3]."])).toEqual({
      text: "Yes and. See the file.",
      ids: ["m2", "t1", "f3"],
    });
  });

  it("holds a Microsoft 365 marker split across chunks", () => {
    expect(run(["It moved [f", "3]."])).toEqual({ text: "It moved.", ids: ["f3"] });
  });

  it("leaves bracketed text that isn't a source id alone", () => {
    expect(run(["Use [x1] or [mail]."])).toEqual({ text: "Use [x1] or [mail].", ids: [] });
  });
});
