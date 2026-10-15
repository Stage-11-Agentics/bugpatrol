import type { UiElement } from './types.js';

type Box = UiElement['box'];
export type FingerDirection = 'up' | 'down' | 'left' | 'right';

/**
 * Where a scroll's finger goes down, and how far it travels. `on` is set when
 * no empty space was left and the start is on an element; `none` says why no
 * start was found, and nothing should be sent.
 */
export type ScrollStart = { x: number; y: number; distance: number; on?: UiElement } | { none: string };

/** Lengths below are for a 402-point phone and scale with the screen's width, since Android tap units are pixels. */
const PHONE_WIDTH = 402;
/** Kept clear of the left and right edges, where a swipe goes back, and of the bottom, where it goes home. */
const EDGE = 24;
const BOTTOM = 40;
/** How far a start stays from the edge of an element, and the spacing of the points tried. */
const CLEAR = 8;
const STEP = 8;
/** Shorter than this, a swipe may land as a tap. */
const MIN_TRAVEL = 60;

/**
 * A scroll's start point, chosen inside `region` (the scrollable area) so the
 * swipe cannot set a value. A control that follows a drag catches a swipe that
 * starts on it: Hum's EQ bands and orb knob are drawn shapes in no tree, and a
 * scroll that began on a band's label dragged that band to +12 dB. `avoid`
 * holds what is known to follow a drag: sliders, switches and pickers in the
 * tree, and the places where this session tapped or dragged a point. No start
 * goes there. The rest is ranked:
 *
 * 1. Empty space on the row of a text: beside a header or a label, where a
 *    layout seldom draws a control.
 * 2. Other empty space.
 * 3. A text or an image.
 * 4. A control that does not follow a drag, such as a list row. A scroll from
 *    a row is how a list scrolls, so this is allowed, and `on` says so.
 *
 * Within a rank, the point nearest the ideal start wins: the region's centre,
 * moved back against the finger by half the travel, so the swipe stays inside.
 */
export function scrollStart(input: {
  screen: { width: number; height: number };
  region: Box;
  direction: FingerDirection;
  /** The usual travel in tap units, before it is fitted to the region. */
  travel: number;
  elements: UiElement[];
  avoid: Box[];
  /** The status bar's height. */
  top: number;
}): ScrollStart {
  const unit = input.screen.width / PHONE_WIDTH;
  const [edge, bottom, clear, step, minTravel] = [
    EDGE * unit,
    BOTTOM * unit,
    CLEAR * unit,
    STEP * unit,
    MIN_TRAVEL * unit,
  ];
  const region = input.region;
  const left = Math.max(region.x + clear, edge);
  const right = Math.min(region.x + region.width - clear, input.screen.width - edge);
  const upper = Math.max(region.y + clear, input.top + clear);
  const lower = Math.min(region.y + region.height - clear, input.screen.height - bottom);
  if (right <= left || lower <= upper) return { none: 'the area to scroll has no room inside the screen' };

  const vertical = input.direction === 'up' || input.direction === 'down';
  const extent = vertical ? lower - upper : right - left;
  const travel = Math.min(input.travel, extent * 0.6);
  // The finger moves one way, so the swipe starts half its travel back the other way.
  const back = { up: { x: 0, y: 1 }, down: { x: 0, y: -1 }, left: { x: 1, y: 0 }, right: { x: -1, y: 0 } }[
    input.direction
  ];
  const ideal = { x: (left + right) / 2 + (back.x * travel) / 2, y: (upper + lower) / 2 + (back.y * travel) / 2 };
  const room = (x: number, y: number) =>
    ({ up: y - upper, down: lower - y, left: x - left, right: right - x })[input.direction];

  const near = (box: Box, x: number, y: number, margin: number) =>
    x >= box.x - margin && x <= box.x + box.width + margin && y >= box.y - margin && y <= box.y + box.height + margin;
  const keyboard = input.elements.filter((element) => element.role === 'keyboard').map((element) => element.box);
  const avoid = [...input.avoid, ...keyboard];
  const elements = input.elements.filter((element) => element.role !== 'keyboard');
  const texts = elements.filter((element) => !element.interactive && element.role === 'text');

  let best: { x: number; y: number; distance: number; on?: UiElement; score: number } | undefined;
  for (let y = upper; y <= lower; y += step) {
    for (let x = left; x <= right; x += step) {
      if (avoid.some((box) => near(box, x, y, clear))) continue;
      const distance = Math.min(travel, room(x, y));
      if (distance < minTravel) continue;
      const under = elements.filter((element) => near(element.box, x, y, clear / 2));
      const rank = under.length
        ? under.some((element) => element.interactive)
          ? 3
          : 2
        : texts.some((text) => y >= text.box.y && y <= text.box.y + text.box.height)
          ? 0
          : 1;
      // A shorter travel costs as much as the same distance away from the ideal start.
      const score = rank * 1e6 + Math.hypot(x - ideal.x, y - ideal.y) + (travel - distance);
      if (!best || score < best.score) {
        const on = rank >= 2 ? (under.find((element) => element.interactive) ?? under.at(-1)) : undefined;
        best = { x, y, distance, ...(on ? { on } : {}), score };
      }
    }
  }
  if (!best) return { none: 'every point in the area to scroll is on or beside a control that follows a drag' };
  const { score: _, ...start } = best;
  return { ...start, x: Math.round(start.x), y: Math.round(start.y), distance: Math.round(start.distance) };
}
