import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Locator, Platform } from '@bugpatrol/core';
import type { ScreenSnapshot } from '@bugpatrol/invariants';
import { elementTitle, locatorFor, stepFor } from './dom.js';
import { nativeSnapshot, pruneSystemChrome } from './maestro.js';
import { tapPoint } from './occlusion.js';
import type { ActResult, Driver, DriverAction, Observation, UiElement } from './types.js';

/**
 * Handset (github.com/Stage-11-Agentics/handset) leases simulators, emulators
 * and phones from a hub and drives them through its CLI. This driver only
 * calls that CLI's public `--json` contract; Handset knows nothing about
 * Bugpatrol. `app.setup` leases the device and runs the app; `app.teardown`
 * releases it.
 */
export type HandsetOptions = {
  /** The lease id, captured from `handset lease --json` in `app.setup`. */
  lease: string;
  /** The handset binary. Default: `handset` on PATH. */
  bin?: string;
  /** Bundle id or package name, reported as the observation's location. */
  appId?: string;
  /** Per-call limit. A call past it fails as retryable. Default 60 s. */
  timeoutMs?: number;
};

/** Runs one handset verb and returns its stdout, even when the verb exits nonzero. */
export type HandsetExec = (args: string[], timeoutMs: number) => Promise<string>;

/** The fields of a Handset tree element this driver reads. Frames are in tap units. */
export type HandsetElement = {
  ref?: string;
  type?: string;
  label?: string;
  text?: string;
  name?: string;
  value?: string;
  id?: string;
  frame?: { x: number; y: number; width: number; height: number };
};

export type HandsetTree = { w: number; h: number; unit: string; elements: HandsetElement[] };

/** One line of `handset log --json`. */
export type HandsetLogLine = {
  t: string;
  verb: string;
  stage?: string;
  msg?: string;
  data?: Record<string, string> | null;
};

type Envelope<T> = {
  ok: boolean;
  verb: string;
  cid: string;
  data: T;
  error: { code: string; message: string; lesson: { id?: string; fix?: string } | string | null } | null;
};

/**
 * A Handset failure. The device or the hub failed, not the app, so callers
 * must not report it as an app bug. `lesson` is Handset's known fix, if any.
 */
export class HandsetError extends Error {
  constructor(
    readonly verb: string,
    readonly code: string,
    message: string,
    readonly lesson: string | null,
  ) {
    super(`handset ${verb}: ${code}: ${message}${lesson ? ` (known fix: ${lesson})` : ''}`);
    this.name = 'HandsetError';
  }
}

/** The target of a tap is covered: the app did nothing wrong, and nothing was tapped. */
class HiddenTarget extends Error {}

const defaultExec =
  (bin: string): HandsetExec =>
  (args, timeoutMs) =>
    new Promise((resolve, reject) => {
      execFile(bin, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
        // A failed verb still prints its envelope; only a missing one is an exec failure.
        if (stdout?.trim()) resolve(stdout);
        else reject(error ?? new Error(`handset ${args[0]} printed nothing`));
      });
    });

const STATUS_BAR = { ios: 54, android: 24 } as const;
const TEXTBOX = /TextField|SecureTextField|SearchField|TextView|EditText/i;
const BUTTON = /Button|Cell|Link|Tab|MenuItem|Switch|Toggle|CheckBox|Slider|Picker|ImageButton/i;

/** The Handset tree in Bugpatrol's normalised element shape, with system chrome removed. */
export function handsetElements(tree: HandsetTree, platform: 'ios' | 'android'): UiElement[] {
  const seen = new Set<string>();
  const elements: UiElement[] = [];
  for (const node of tree.elements) {
    const box = node.frame;
    if (!box || box.width <= 0 || box.height <= 0) continue;
    const name = (node.label || node.name || node.text || node.value || node.id || '').trim();
    const type = node.type ?? '';
    const role = TEXTBOX.test(type)
      ? 'textbox'
      : BUTTON.test(type)
        ? type.match(/Switch|Toggle|CheckBox/i)
          ? 'switch'
          : 'button'
        : /StaticText|TextView$/i.test(type)
          ? 'text'
          : /Image/i.test(type)
            ? 'image'
            : 'group';
    const interactive = role === 'button' || role === 'textbox' || role === 'switch';
    // A control with no name is still a control: Hum's toggles are buttons with no label.
    if (!name && !interactive) continue;
    // iOS reports a static text twice, once by identifier and once by value, on one frame.
    const key = `${node.label ?? name}|${box.x},${box.y},${box.width},${box.height}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // An id equal to the visible label is the platform's fallback, not an identifier the app set.
    const testId = node.id && node.id !== (node.label || node.name) ? node.id : undefined;
    elements.push({
      ref: '',
      role,
      name,
      text: node.text || undefined,
      value: node.value || undefined,
      testId,
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
      interactive,
      enabled: true,
    });
  }
  const kept = pruneSystemChrome(elements, { width: tree.w, height: tree.h }, STATUS_BAR[platform]);
  return kept.map((element) => {
    const near = element.name ? undefined : nearestName(element, kept);
    return near ? { ...element, near } : element;
  });
}

/** How far above or below an unnamed control a name may be, in tap units, when its own row has none. */
const NEAR_ROW = 44;

/**
 * The name nearest an unnamed control, so the explorer can tell it apart from
 * the others: the closest on its own row (a settings row puts its label at
 * the far left and its toggle at the far right), otherwise the closest on the
 * row just above or below. A container that holds the control is around it,
 * not near it.
 */
function nearestName(target: UiElement, elements: UiElement[]): string | undefined {
  const a = target.box;
  let best: { name: string; score: number } | undefined;
  for (const item of elements) {
    if (!item.name || item.role === 'keyboard') continue;
    const b = item.box;
    const holds = b.x <= a.x && b.y <= a.y && b.x + b.width >= a.x + a.width && b.y + b.height >= a.y + a.height;
    if (holds) continue;
    const dx = Math.max(0, b.x - (a.x + a.width), a.x - (b.x + b.width));
    const dy = Math.max(0, b.y - (a.y + a.height), a.y - (b.y + b.height));
    const score = dy === 0 ? dx : dy <= NEAR_ROW ? 10_000 + dy * 2 + dx : Number.POSITIVE_INFINITY;
    if (score < (best?.score ?? Number.POSITIVE_INFINITY)) best = { name: item.name, score };
  }
  return best?.name.slice(0, 40);
}

/**
 * What the app itself reported as an error since the last observation: crashes,
 * Error and Fault lines from the app's own subsystem, and error-level console
 * lines. Apple and Android framework chatter at error level is dropped: a
 * refused socket in `com.apple.network` is not a bug in the app.
 */
export function appErrors(lines: HandsetLogLine[], after: number): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (Date.parse(line.t) <= after) continue;
    const data = line.data ?? {};
    const msg = (line.msg ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!msg) continue;
    if (line.stage === 'crash') {
      out.push(`crash: ${msg}`);
      continue;
    }
    if (line.verb !== 'app' && line.verb !== 'device') continue;
    const level = (data.message_type ?? data.level ?? '').toLowerCase();
    if (level !== 'error' && level !== 'fault') continue;
    const subsystem = data.subsystem ?? '';
    if (/^(com\.apple\.|android\.|androidx\.)/.test(subsystem)) continue;
    out.push(data.process ? `${data.process}: ${msg}` : msg);
  }
  return out.slice(-20);
}

/** Frames that differ by no more than this, in tap units, are the same frame. */
const LAYOUT_TOLERANCE = 1;

/**
 * Whether two trees have the same layout: the same elements, by type, in the
 * same order, each with the same row (y and height) and at least one of its
 * left edge, centre or right edge in the same place. Labels and values are
 * left out, so live data (a speed, a clock, a percentage) that ticks on every
 * read does not hold up settling. When a label ticks its width changes, but
 * the edge it is aligned by stays put; an element that slides moves all three.
 */
export function sameLayout(a: HandsetTree, b: HandsetTree): boolean {
  const framed = (tree: HandsetTree) => tree.elements.filter((element) => element.frame);
  const left = framed(a);
  const right = framed(b);
  if (left.length !== right.length) return false;
  const near = (p: number, q: number) => Math.abs(p - q) <= LAYOUT_TOLERANCE;
  return left.every((element, index) => {
    const other = right[index]!;
    const [p, q] = [element.frame!, other.frame!];
    return (
      (element.type ?? '') === (other.type ?? '') &&
      near(p.y, q.y) &&
      near(p.height, q.height) &&
      (near(p.x, q.x) || near(p.x + p.width / 2, q.x + q.width / 2) || near(p.x + p.width, q.x + q.width))
    );
  });
}

/** Bugpatrol scrolls the content; a swipe moves the finger the other way. */
export function swipeDirection(direction: 'up' | 'down' | 'left' | 'right'): string {
  return { up: 'down', down: 'up', left: 'right', right: 'left' }[direction];
}

/** Drive a leased Handset device. */
export class HandsetDriver implements Driver {
  private lastObservation?: Observation;
  /** Milliseconds since the epoch of the newest log line already reported. */
  private lastLogAt = 0;
  private readonly exec: HandsetExec;
  private readonly timeoutMs: number;

  constructor(
    readonly platform: Extract<Platform, 'ios' | 'android'>,
    private readonly options: HandsetOptions,
    exec?: HandsetExec,
  ) {
    this.exec = exec ?? defaultExec(options.bin ?? 'handset');
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  /** Run a verb on the lease and return its data, or throw `HandsetError`. */
  private async call<T>(verb: string, args: string[] = []): Promise<T> {
    let stdout: string;
    try {
      stdout = await this.exec([verb, '--lease', this.options.lease, ...args, '--json'], this.timeoutMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new HandsetError(verb, 'exec', message.slice(0, 200), null);
    }
    const envelope = JSON.parse(stdout.trim().split('\n').at(-1)!) as Envelope<T>;
    if (!envelope.ok) {
      const lesson = envelope.error?.lesson;
      const fix = typeof lesson === 'string' ? lesson : (lesson?.fix ?? lesson?.id ?? null);
      throw new HandsetError(verb, envelope.error?.code ?? 'error', envelope.error?.message ?? 'failed', fix);
    }
    return envelope.data;
  }

  async connect(): Promise<void> {
    // The first tree warms the hub's drive bridge, so the first observation is not the slow one.
    await this.call<HandsetTree>('tree');
    this.lastLogAt = Date.now();
  }

  private async logs(): Promise<string[]> {
    const since = this.lastLogAt ? Math.ceil((Date.now() - this.lastLogAt) / 1000) + 2 : 60;
    const stdout = await this.exec(
      ['log', '--id', this.options.lease, '--since', `${since}s`, '--json'],
      this.timeoutMs,
    ).catch(() => '');
    const lines: HandsetLogLine[] = [];
    for (const raw of stdout.split('\n')) {
      if (!raw.trim()) continue;
      try {
        const line = JSON.parse(raw) as HandsetLogLine & { ok?: boolean; verb?: string };
        if (typeof line.t === 'string') lines.push(line);
      } catch {
        // The closing envelope and any partial line are not log lines.
      }
    }
    const errors = appErrors(lines, this.lastLogAt);
    this.lastLogAt = lines.reduce((max, line) => Math.max(max, Date.parse(line.t) || 0), this.lastLogAt);
    return errors;
  }

  async observe(): Promise<Observation> {
    const dir = await mkdtemp(join(tmpdir(), 'bp-handset-'));
    try {
      const out = join(dir, 'shot.png');
      const [tree, shot, consoleErrors] = await Promise.all([
        this.call<HandsetTree>('tree'),
        this.call<{ scale: number; tap_w: number; tap_h: number }>('shot', ['--out', out]),
        this.logs(),
      ]);
      const screenshot = await readFile(out);
      const statusBar = STATUS_BAR[this.platform];
      const observation: Observation = {
        platform: this.platform,
        location: this.options.appId ?? `handset:${this.options.lease}`,
        screenshot,
        viewport: { width: tree.w, height: tree.h, scale: shot.scale },
        elements: handsetElements(tree, this.platform),
        volatileRegions: [{ x: 0, y: 0, width: tree.w, height: statusBar, reason: 'status bar' }],
        consoleErrors,
        at: new Date().toISOString(),
      };
      this.lastObservation = observation;
      return observation;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private element(action: { ref?: string }): UiElement | undefined {
    if (!action.ref) return undefined;
    const element = this.lastObservation?.elements.find((item) => item.ref === action.ref);
    if (!element) throw new Error(`Unknown element ref: ${action.ref}`);
    return element;
  }

  /**
   * Tap the element where it shows (its centre unless something covers it),
   * or a recorded locator by id or label, then by point. `point` is set when
   * the tap was not at the element's centre.
   */
  private async tapTarget(
    element?: UiElement,
    locator?: Locator,
  ): Promise<{ degraded: boolean; point?: { x: number; y: number } }> {
    if (element) {
      const at = tapPoint(element, this.lastObservation?.elements ?? [element]);
      if ('hidden' in at) {
        throw new HiddenTarget(
          `Not tapped: ${elementTitle(element)} is covered by ${elementTitle(at.hidden)} and does not show. Scroll it into view or close what covers it, then look again.`,
        );
      }
      await this.call('tap', ['--x', String(at.x), '--y', String(at.y)]);
      return { degraded: false, ...(at.covered ? { point: { x: at.x, y: at.y } } : {}) };
    }
    if (!locator) throw new Error('Tap needs a target');
    for (const label of [locator.testId, locator.name, locator.text]) {
      if (!label) continue;
      try {
        await this.call('tap', ['--label', label]);
        return { degraded: false };
      } catch (error) {
        if (!(error instanceof HandsetError) || error.code === 'exec') throw error;
      }
    }
    if (!locator.point) throw new Error('No element matches the locator');
    await this.call('tap', ['--x', String(locator.point.x), '--y', String(locator.point.y)]);
    return { degraded: true };
  }

  async act(action: DriverAction): Promise<ActResult> {
    try {
      let element: UiElement | undefined;
      let degraded = false;
      let point: { x: number; y: number } | undefined;
      switch (action.kind) {
        case 'tap': {
          element = this.element(action);
          ({ degraded, point } = await this.tapTarget(element, action.locator));
          break;
        }
        case 'type': {
          element = this.element(action);
          if (element || action.locator) ({ degraded, point } = await this.tapTarget(element, action.locator));
          // Handset has no clear verb yet, so `append: false` on a filled field appends.
          await this.call('type', ['--text', action.value, ...(action.submit ? ['--submit'] : [])]);
          break;
        }
        case 'scroll': {
          element = this.element(action);
          const args = ['--direction', swipeDirection(action.direction)];
          if (element) {
            const { x, y } = locatorFor(element).point!;
            args.push('--x', String(x), '--y', String(y));
          }
          await this.call('swipe', args);
          break;
        }
        case 'back': {
          if (this.platform === 'android') return { ok: false, error: 'Handset has no key verb for Android back yet' };
          const height = this.lastObservation?.viewport.height ?? 874;
          const width = this.lastObservation?.viewport.width ?? 402;
          await this.call('swipe', [
            '--direction',
            'right',
            '--x',
            '2',
            '--y',
            String(Math.round(height / 2)),
            '--distance',
            String(Math.round(width * 0.8)),
          ]);
          break;
        }
        case 'wait':
          await new Promise((resolve) => setTimeout(resolve, action.ms));
          break;
        case 'press':
          return { ok: false, error: 'Handset has no key verb yet' };
        case 'open':
          return { ok: false, error: 'Handset has no deep-link verb yet' };
        case 'upload':
          return { ok: false, error: 'Uploads are supported on web and Electron only' };
        case 'window':
          return { ok: false, error: 'Window switching is unsupported on mobile' };
        case 'request':
          return { ok: false, error: 'HTTP requests require the API driver' };
        case 'run':
          return { ok: false, error: 'Commands require the CLI driver' };
      }
      const fallback = 'locator' in action ? action.locator : undefined;
      const step = stepFor(action, element, fallback);
      // A replay that falls back to the point must tap where this tap landed.
      if (point && (step.kind === 'tap' || step.kind === 'type') && step.target) step.target.point = point;
      return { ok: true, ...(degraded ? { degraded } : {}), step };
    } catch (error) {
      if (error instanceof HiddenTarget) return { ok: false, retryable: false, error: error.message };
      if (error instanceof HandsetError) {
        return { ok: false, retryable: true, error: `device, not app: ${error.message}`.slice(0, 300) };
      }
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message.slice(0, 200) };
    }
  }

  /**
   * Settled means the layout stopped changing: two tree reads in a row with
   * `sameLayout`. A tree read is under a second when warm; the
   * timeout is the backstop for a screen that keeps moving.
   */
  async settle(
    options: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<{ frames: number; stable: boolean }> {
    const timeout = options.timeoutMs ?? 6000;
    const interval = options.intervalMs ?? 250;
    const start = Date.now();
    let previous: HandsetTree | undefined;
    let frames = 0;
    while (Date.now() - start < timeout) {
      const tree = await this.call<HandsetTree>('tree');
      frames++;
      if (previous && sameLayout(previous, tree)) return { frames, stable: true };
      previous = tree;
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
    return { frames, stable: false };
  }

  snapshot(observation: Observation, screenId: string): ScreenSnapshot {
    return nativeSnapshot(observation, screenId);
  }

  async close(): Promise<void> {
    // The lease belongs to app.setup and app.teardown.
  }
}
