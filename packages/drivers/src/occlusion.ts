import type { UiElement } from './types.js';

type Box = UiElement['box'];

/** Points closer than this to a covering element's edge count as covered. */
const MARGIN = 2;
/** The spacing of the points tried when the centre is covered. */
const STEP = 4;

const inside = (inner: Box, outer: Box) =>
  inner.x >= outer.x - 1 &&
  inner.y >= outer.y - 1 &&
  inner.x + inner.width <= outer.x + outer.width + 1 &&
  inner.y + inner.height <= outer.y + outer.height + 1;

const covers = (box: Box, x: number, y: number) =>
  x >= box.x - MARGIN && x <= box.x + box.width + MARGIN && y >= box.y - MARGIN && y <= box.y + box.height + MARGIN;

export type TapPoint = { x: number; y: number; covered?: UiElement } | { hidden: UiElement };

/**
 * Where a tap lands on `target`. An element later in the tree is drawn over
 * it, unless it lies inside the target (its own label or icon). When one
 * covers the centre, the point that shows nearest the centre; when none
 * shows, `hidden` names what covers it, so the tap goes to neither element.
 */
export function tapPoint(target: UiElement, elements: UiElement[]): TapPoint {
  const box = target.box;
  const centre = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  const after = elements.slice(elements.indexOf(target) + 1);
  const over = after.filter((item) => !inside(item.box, box));
  const coveredAt = (x: number, y: number) => over.find((item) => covers(item.box, x, y));
  const covered = coveredAt(centre.x, centre.y);
  if (!covered) return centre;
  // A grid through the centre, kept clear of the target's own edges.
  const steps = (from: number, low: number, high: number) => {
    const out: number[] = [];
    for (let at = from; at >= low; at -= STEP) out.push(at);
    for (let at = from + STEP; at <= high; at += STEP) out.push(at);
    return out;
  };
  let best: { x: number; y: number; distance: number } | undefined;
  for (const y of steps(centre.y, box.y + MARGIN, box.y + box.height - MARGIN)) {
    for (const x of steps(centre.x, box.x + MARGIN, box.x + box.width - MARGIN)) {
      if (coveredAt(x, y)) continue;
      const distance = Math.hypot(x - centre.x, y - centre.y);
      if (!best || distance < best.distance) best = { x, y, distance };
    }
  }
  return best ? { x: best.x, y: best.y, covered } : { hidden: covered };
}
