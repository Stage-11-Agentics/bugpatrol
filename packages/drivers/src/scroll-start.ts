import type { UiElement } from './types.js';

type Box = UiElement['box'];
export type FingerDirection = 'up' | 'down' | 'left' | 'right';

/**
 * Where a scroll's finger goes down, and how far it travels. `on` is set when
 * the start is on a control, since nothing else was clear; `none` says why no
 * start was found, and nothing should be sent.
 */
export type ScrollStart = { x: number; y: number; distance: number; on?: UiElement } | { none: string };

/** Lengths below are for a 402-point phone and scale with the screen's short side, since Android tap units are pixels. */
const PHONE_WIDTH = 402;
/** Kept clear of the left and right edges, where a swipe goes back, and of the bottom, where it goes home or meets Android's navigation bar. */
const EDGE = 24;
const BOTTOM = 48;
/** How far a start stays inside the area to scroll, and the spacing of the points tried. */
const CLEAR = 8;
const STEP = 8;
/** Shorter than this, a swipe may land as a tap. */
const MIN_TRAVEL = 60;
/**
 * A finger this close to a control can still grab it. On Hum, swipes that
 * began 10 to 12 points outside an EQ band and outside the notch slider
 * dragged them: iOS hit-tests the finger, not a point.
 */
const REACH = 24;
/** The empty square in which an app may draw a control that no tree lists: the minimum touch target. */
const ROOM = 44;
/** The grid that empty space is measured on. */
const CELL = 2;

/**
 * A scroll's start point, chosen inside `region` (the scrollable area) so the
 * swipe cannot set a value. Apps draw sliders, faders and knobs as shapes with
 * drag gestures, and no tree lists them: Hum's EQ bands fill the empty space
 * between their values and their labels, its notch slider the space under its
 * row, and a scroll that began beside a band's label dragged it to +12 dB.
 *
 * So empty space is not safe. Any empty square of `ROOM` inside the content
 * column may hold a drawn control. The content column runs from the leftmost
 * to the rightmost element, mirrored about the area's centre, since layouts
 * pad both sides alike. Whatever holds no other element fills it, however big:
 * a text, a button, a field, an image, a carousel's page, a React Native or
 * Compose row (one named group). A container does not, since its own empty
 * space may hold a drawn control: its elements fill it instead. A start keeps `REACH` from every such square and
 * every control that follows a drag (`drags`, and an image or group that
 * reports a value, such as Hum's volume knob), `CLEAR` from switches,
 * segmented controls and the keyboard (`controls`), and stays off the whole row of a place this
 * session tapped or dragged (`touched`). What is left is a text, a button or a
 * gap too small to draw in, among other elements, or the margin outside the
 * content column. A tree that lists nothing gives no such place.
 *
 * Of those, a start off any control comes first, then one on a control that
 * does not follow a drag, such as a list row (`on` says so). Within each, the
 * point nearest the ideal start wins. With a known scroll container that is
 * its centre, moved back against the finger by half the travel so the swipe
 * stays inside; without one it is the screen's centre, where Handset itself
 * starts a swipe. With no such point the scroll is refused.
 */
export function scrollStart(input: {
  screen: { width: number; height: number };
  /** The scroll container; undefined when the tree lists none. */
  region?: Box;
  direction: FingerDirection;
  /** The usual travel in tap units, before it is fitted to the region. */
  travel: number;
  elements: UiElement[];
  /** Controls in the tree that follow a drag of the finger: sliders, pickers, maps. */
  drags: Box[];
  /** Controls in the tree that flick or are tapped: switches, segmented controls. */
  controls: Box[];
  /** Around the places where this session tapped a bare point or began a drag, on this layout. */
  touched: Box[];
  /** The status bar's height. */
  top: number;
}): ScrollStart {
  const unit = Math.min(input.screen.width, input.screen.height) / PHONE_WIDTH;
  const [edge, bottom, clear, step, minTravel, reach, room, cell] = [
    EDGE,
    BOTTOM,
    CLEAR,
    STEP,
    MIN_TRAVEL,
    REACH,
    ROOM,
    CELL,
  ].map((length) => length * unit) as [number, number, number, number, number, number, number, number];
  const region = input.region ?? { x: 0, y: 0, ...input.screen };
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
  const shift = input.region ? travel / 2 : 0;
  const ideal = { x: (left + right) / 2 + back.x * shift, y: (upper + lower) / 2 + back.y * shift };
  const roomFor = (x: number, y: number) =>
    ({ up: y - upper, down: lower - y, left: x - left, right: right - x })[input.direction];

  const near = (box: Box, x: number, y: number, margin: number) =>
    x > box.x - margin && x < box.x + box.width + margin && y > box.y - margin && y < box.y + box.height + margin;
  // An element over half the area is a background or a page (a named ScrollView, an Android
  // RecyclerView with an id), not something a start is on; it still fills the content column below.
  const overlap = (box: Box) =>
    Math.max(0, Math.min(box.x + box.width, region.x + region.width) - Math.max(box.x, region.x)) *
    Math.max(0, Math.min(box.y + box.height, region.y + region.height) - Math.max(box.y, region.y));
  const elements = input.elements.filter(
    (element) => element.role !== 'keyboard' && overlap(element.box) < 0.5 * region.width * region.height,
  );
  const reports = (element: UiElement) => (element.role === 'image' || element.role === 'group') && !!element.value;
  const drags = [...input.drags, ...input.elements.filter(reports).map((element) => element.box)];
  const controls = [
    ...input.controls,
    ...input.elements.filter((element) => element.role === 'keyboard').map((element) => element.box),
  ];
  const within = (inner: Box, outer: Box) =>
    inner.x >= outer.x - unit &&
    inner.y >= outer.y - unit &&
    inner.x + inner.width <= outer.x + outer.width + unit &&
    inner.y + inner.height <= outer.y + outer.height + unit;
  const listed = input.elements.filter(
    (element) =>
      element.role !== 'keyboard' &&
      !reports(element) &&
      !(within(element.box, region) && within(region, element.box)) &&
      element.box.y < input.screen.height &&
      element.box.y + element.box.height > 0,
  );
  const fills = listed.filter(
    (element) => !listed.some((other) => other !== element && within(other.box, element.box)),
  );
  const inArea = (box: Box) =>
    box.x < region.x + region.width &&
    region.x < box.x + box.width &&
    box.y < region.y + region.height &&
    region.y < box.y + box.height;
  if (!fills.some((element) => inArea(element.box)))
    return { none: 'the tree lists nothing in the area to scroll, so the app may draw a control anywhere in it' };
  const space = drawable(fills, region, input.screen, input.top, room, cell);

  let best: { x: number; y: number; distance: number; on?: UiElement; score: number } | undefined;
  let clearButShort = false;
  for (let y = upper; y <= lower; y += step) {
    if (input.touched.some((box) => y > box.y && y < box.y + box.height)) continue;
    for (let x = left; x <= right; x += step) {
      if (drags.some((box) => near(box, x, y, reach)) || controls.some((box) => near(box, x, y, clear))) continue;
      if (space(x, y, reach)) continue;
      const distance = Math.min(travel, roomFor(x, y));
      if (distance < minTravel) {
        clearButShort = true;
        continue;
      }
      const on = elements.find((element) => element.interactive && near(element.box, x, y, clear / 2));
      // A shorter travel costs as much as the same distance away from the ideal start.
      const score = (on ? 1e6 : 0) + Math.hypot(x - ideal.x, y - ideal.y) + (travel - distance);
      if (!best || score < best.score) best = { x, y, distance, ...(on ? { on } : {}), score };
    }
  }
  if (!best) {
    return {
      none: clearButShort
        ? 'the area to scroll is too short for a swipe'
        : 'every point in the area to scroll is on or near a control that follows a drag, or near empty space where the app may draw one',
    };
  }
  const { score: _, ...start } = best;
  return { ...start, x: Math.round(start.x), y: Math.round(start.y), distance: Math.round(start.distance) };
}

/**
 * Whether an empty square of side `room`, inside the content column, comes
 * within `reach` of a point: the space where an app may draw a control that
 * the tree does not list. Measured on a grid of `cell`, where a cell that any
 * element touches is filled, with prefix sums so each question is answered at
 * once.
 */
function drawable(
  fills: UiElement[],
  region: Box,
  screen: { width: number; height: number },
  top: number,
  room: number,
  cell: number,
): (x: number, y: number, reach: number) => boolean {
  const centre = region.x + region.width / 2;
  const leftmost = Math.min(...fills.map((element) => element.box.x));
  const rightmost = Math.max(...fills.map((element) => element.box.x + element.box.width));
  let [from, to] = [
    Math.max(region.x, Math.min(leftmost, 2 * centre - rightmost)),
    Math.min(region.x + region.width, Math.max(rightmost, 2 * centre - leftmost)),
  ];
  // Content narrower than a control, such as one spinner, says nothing about where the column is.
  if (to - from < room) [from, to] = [region.x, region.x + region.width];
  const cols = Math.ceil((to - from) / cell);
  const rows = Math.ceil((screen.height - top) / cell);
  // A cell an element touches is filled, so a gap of `room` holds at least this many free cells.
  const side = Math.round(room / cell) - 1;
  if (cols < side || rows < side) return () => true;

  // Filled cells, from a difference grid of every element.
  const width = cols + 1;
  const marks = new Int32Array(width * (rows + 1));
  for (const { box } of fills) {
    const i0 = Math.max(0, Math.floor((box.x - from) / cell));
    const i1 = Math.min(cols, Math.ceil((box.x + box.width - from) / cell));
    const j0 = Math.max(0, Math.floor((box.y - top) / cell));
    const j1 = Math.min(rows, Math.ceil((box.y + box.height - top) / cell));
    if (i1 <= i0 || j1 <= j0) continue;
    marks[j0 * width + i0]! += 1;
    marks[j0 * width + i1]! -= 1;
    marks[j1 * width + i0]! -= 1;
    marks[j1 * width + i1]! += 1;
  }
  for (let j = 0; j <= rows; j++) for (let i = 1; i <= cols; i++) marks[j * width + i]! += marks[j * width + i - 1]!;
  for (let j = 1; j <= rows; j++) for (let i = 0; i <= cols; i++) marks[j * width + i]! += marks[(j - 1) * width + i]!;
  const filled = summed(cols, rows, (i, j) => (marks[j * width + i]! > 0 ? 1 : 0));
  // Empty squares, by their top-left cell.
  const [freeCols, freeRows] = [cols - side + 1, rows - side + 1];
  const free = summed(freeCols, freeRows, (i, j) => (filled(i, j, i + side - 1, j + side - 1) === 0 ? 1 : 0));
  return (x, y, reach) => {
    // A square at cell i spans [from + i * cell, from + (i + side) * cell); rounded outward.
    const i0 = Math.max(0, Math.floor((x - reach - from) / cell) - side);
    const i1 = Math.min(freeCols - 1, Math.floor((x + reach - from) / cell));
    const j0 = Math.max(0, Math.floor((y - reach - top) / cell) - side);
    const j1 = Math.min(freeRows - 1, Math.floor((y + reach - top) / cell));
    return i0 <= i1 && j0 <= j1 && free(i0, j0, i1, j1) > 0;
  };
}

/** The sum of `value` over any block of a `cols` by `rows` grid, from inclusive corners. */
function summed(
  cols: number,
  rows: number,
  value: (i: number, j: number) => number,
): (i0: number, j0: number, i1: number, j1: number) => number {
  const width = cols + 1;
  const sums = new Int32Array(width * (rows + 1));
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      sums[(j + 1) * width + i + 1] =
        value(i, j) + sums[j * width + i + 1]! + sums[(j + 1) * width + i]! - sums[j * width + i]!;
    }
  }
  return (i0, j0, i1, j1) =>
    sums[(j1 + 1) * width + i1 + 1]! -
    sums[j0 * width + i1 + 1]! -
    sums[(j1 + 1) * width + i0]! +
    sums[j0 * width + i0]!;
}
