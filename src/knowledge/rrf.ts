export interface Fused<T> {
  item: T;
  id: string;
  score: number;
}

/**
 * Reciprocal rank fusion: each list adds 1 / (k + rank) to an item's score, so items found by
 * several lists rise, and k sets how much top ranks outweigh lower ones. Items are matched by
 * `id`; the first occurrence is kept. Sorted by score, highest first.
 */
export function reciprocalRankFusion<T extends { id: string }>(
  lists: T[][],
  k: number,
): Fused<T>[] {
  const fused = new Map<string, Fused<T>>();
  for (const list of lists) {
    list.forEach((item, index) => {
      const add = 1 / (k + index + 1);
      const existing = fused.get(item.id);
      if (existing) existing.score += add;
      else fused.set(item.id, { item, id: item.id, score: add });
    });
  }
  return [...fused.values()].sort((a, b) => b.score - a.score);
}
