import { describe, expect, it } from "vitest";
import { reciprocalRankFusion } from "@/knowledge/rrf";

const ids = (items: { id: string }[]) => items.map((item) => item.id);

describe("reciprocalRankFusion", () => {
  it("ranks an item found by both lists above items found by one", () => {
    const merged = reciprocalRankFusion(
      [
        [{ id: "a" }, { id: "both" }],
        [{ id: "b" }, { id: "both" }],
      ],
      60,
    );
    expect(ids(merged)).toEqual(["both", "a", "b"]);
  });

  it("keeps each item once, with the summed score", () => {
    const merged = reciprocalRankFusion([[{ id: "x" }], [{ id: "x" }]], 60);
    expect(merged).toEqual([{ item: { id: "x" }, id: "x", score: 2 / 61 }]);
  });

  it("orders by rank within a single list", () => {
    expect(ids(reciprocalRankFusion([[{ id: "1" }, { id: "2" }, { id: "3" }]], 60))).toEqual([
      "1",
      "2",
      "3",
    ]);
  });

  it("lets a smaller constant favour top ranks more", () => {
    const lists = [
      [{ id: "top" }, { id: "x1" }, { id: "x2" }, { id: "both" }],
      [{ id: "y1" }, { id: "y2" }, { id: "y3" }, { id: "both" }],
    ];
    expect(ids(reciprocalRankFusion(lists, 60))[0]).toBe("both");
    expect(ids(reciprocalRankFusion(lists, 1))[0]).toBe("top");
  });

  it("returns nothing for no results", () => {
    expect(reciprocalRankFusion([[], []], 60)).toEqual([]);
  });
});
