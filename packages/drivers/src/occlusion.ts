import type { UiElement } from './types.js';

type Box = UiElement['box'];

/** Points closer than this to a covering element's edge count as covered. */
const MARGIN = 2;
/** The spacing of the points tried when the centre is covered. */
const STEP = 4;

/** How far a child's frame may overhang its parent's (a badge, a wide label) and still be inside it. */
const OVERHANG = 4;

const inside = (inner: Box, outer: Box, overhang = OVERHANG) =>
  inner.x >= outer.x - overhang &&
  inner.y >= outer.y - overhang &&
  inner.x + inner.width <= outer.x + outer.width + overhang &&
  inner.y + inner.height <= outer.y + outer.height + overhang;

const covers = (box: Box, x: number, y: number) =>
  x >= box.x - MARGIN && x <= box.x + box.width + MARGIN && y >= box.y - MARGIN && y <= box.y + box.height + MARGIN;

export type TapPoint = { x: number; y: number; covered?: UiElement } | { hidden: UiElement };

/**
 * Where a tap lands on `target`. Handset's trees list a parent before its
 * children, so an element later in the tree is drawn over the target, except:
 * one that lies inside it (its own label or icon), and a container that is
 * not a control and holds all of it (a scroll view, a background), which is
 * more likely behind than in front. That also lets through a sheet or a scrim
 * that is not a control, as the plain centre tap did. The software keyboard
 * always covers.
 * When something covers the centre, the point that shows nearest the centre;
 * when none shows, `hidden` names the topmost cover, and nothing is tapped.
 */
export function tapPoint(target: UiElement, elements: UiElement[]): TapPoint {
  const box = target.box;
  const centre = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  const after = elements.slice(elements.indexOf(target) + 1);
  const over = after
    .filter(
      (item) => item.role === 'keyboard' || (!inside(item.box, box) && (item.interactive || !inside(box, item.box, 1))),
    )
    .reverse();
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
