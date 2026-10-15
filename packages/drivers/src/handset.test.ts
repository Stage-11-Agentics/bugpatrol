import { describe, expect, it } from 'vitest';
import {
  appErrors,
  HandsetDriver,
  type HandsetExec,
  type HandsetLogLine,
  type HandsetTree,
  handsetElements,
  sameLayout,
  swipeDirection,
} from './handset.js';

// Recorded from `handset tree --json` on an iPhone 17 Pro simulator running Handset's Expo fixture.
const tree: HandsetTree = {
  w: 402,
  h: 874,
  unit: 'tap',
  elements: [
    {
      ref: '@e1',
      type: 'StaticText',
      label: '0',
      name: 'count',
      id: 'count',
      frame: { x: 181, y: 317, width: 39, height: 76 },
    },
    { ref: '@e2', type: 'StaticText', label: '0', name: '0', frame: { x: 181, y: 317, width: 39, height: 76 } },
    {
      ref: '@e3',
      type: 'Button',
      label: 'Dial',
      name: 'dial-button',
      id: 'dial-button',
      frame: { x: 91, y: 418, width: 220, height: 68 },
    },
    {
      ref: '@e4',
      type: 'Button',
      label: 'Settings',
      name: 'settings-button',
      id: 'settings-button',
      frame: { x: 156, y: 511, width: 90, height: 45 },
    },
    {
      ref: '@e5',
      type: 'Image',
      label: 'gearshape.fill',
      name: 'gearshape.fill',
      id: 'gearshape.fill',
      frame: { x: 348, y: 96, width: 26, height: 26 },
    },
    { ref: '@e6', type: 'StaticText', label: '17:58', name: '17:58', frame: { x: 51, y: 22, width: 45, height: 20 } },
    {
      ref: '@e7',
      type: 'Other',
      name: '3 of 3 Wi-Fi bars',
      id: '3 of 3 Wi-Fi bars',
      value: 'SSID, 3 of 3 Wi-Fi bars',
      frame: { x: 315, y: 26, width: 17, height: 12 },
    },
  ],
};

// Recorded from `handset log --id <lease> --json` on the same lease, trimmed.
const lines: HandsetLogLine[] = [
  {
    t: '2026-10-14T21:52:44.000Z',
    verb: 'app',
    stage: 'log',
    msg: 'nw_socket_handle_socket_event [C2.1.1.1:1] Socket SO_ERROR [61: Connection refused]',
    data: { message_type: 'Error', process: 'expodial', subsystem: 'com.apple.network' },
  },
  {
    t: '2026-10-14T21:52:51.865Z',
    verb: 'app',
    stage: 'log',
    msg: 'expo-dial:mount',
    data: { message_type: 'Info', process: 'expodial', subsystem: 'host.exp.dial' },
  },
  {
    t: '2026-10-14T21:52:52.000Z',
    verb: 'app',
    stage: 'log',
    msg: 'dial: count overflow',
    data: { message_type: 'Error', process: 'expodial', subsystem: 'host.exp.dial' },
  },
  {
    t: '2026-10-14T21:52:53.000Z',
    verb: 'device',
    stage: 'crash',
    msg: 'expodial crashed: EXC_BAD_ACCESS',
    data: { process: 'expodial' },
  },
  {
    t: '2026-10-14T21:52:54.000Z',
    verb: 'app',
    msg: 'TypeError: undefined is not a function',
    data: { level: 'error' },
  },
  { t: '2026-10-14T21:52:55.000Z', verb: 'tree', stage: 'tree', msg: '', data: {} },
];

describe('handsetElements', () => {
  const elements = handsetElements(tree, 'ios');

  it('drops the status bar and the duplicate static text', () => {
    expect(elements.map((element) => element.name)).toEqual(['0', 'Dial', 'Settings', 'gearshape.fill']);
  });

  it('keeps identifiers the app set and refs Bugpatrol owns', () => {
    expect(elements.map((element) => [element.ref, element.role, element.testId])).toEqual([
      ['e1', 'text', 'count'],
      ['e2', 'button', 'dial-button'],
      ['e3', 'button', 'settings-button'],
      ['e4', 'image', undefined],
    ]);
  });

  it('keeps boxes in tap units', () => {
    expect(elements[1]!.box).toEqual({ x: 91, y: 418, width: 220, height: 68 });
  });
});

describe('appErrors', () => {
  it('reports the app and its crashes, not framework chatter', () => {
    expect(appErrors(lines, 0)).toEqual([
      'expodial: dial: count overflow',
      'crash: expodial crashed: EXC_BAD_ACCESS',
      'TypeError: undefined is not a function',
    ]);
  });

  it('skips lines already reported', () => {
    expect(appErrors(lines, Date.parse('2026-10-14T21:52:53.000Z'))).toEqual([
      'TypeError: undefined is not a function',
    ]);
  });
});

describe('sameLayout', () => {
  const one = (frame: { x: number; y: number; width: number; height: number }, type = 'StaticText'): HandsetTree => ({
    ...tree,
    elements: [{ type, label: 'x', frame }],
  });
  const at = { x: 100, y: 300, width: 80, height: 20 };

  it('holds while a label ticks, on whichever edge it is aligned by', () => {
    expect(sameLayout(one(at), one({ ...at, width: 86 }))).toBe(true); // left-aligned
    expect(sameLayout(one(at), one({ ...at, x: 97, width: 86 }))).toBe(true); // centred
    expect(sameLayout(one(at), one({ ...at, x: 94, width: 86 }))).toBe(true); // right-aligned
    expect(sameLayout(one(at, 'Button'), one({ ...at, x: 97, width: 86 }, 'Button'))).toBe(true);
  });

  it('ignores sub-point jitter', () => {
    expect(sameLayout(one(at), one({ x: 100.4, y: 300.6, width: 79.7, height: 20.33 }))).toBe(true);
  });

  it('sees an element slide, move down, resize in height, change type, or appear', () => {
    expect(sameLayout(one(at), one({ ...at, x: 140 }))).toBe(false);
    expect(sameLayout(one(at), one({ ...at, y: 310 }))).toBe(false);
    expect(sameLayout(one(at), one({ ...at, height: 40 }))).toBe(false);
    expect(sameLayout(one(at), one(at, 'Button'))).toBe(false);
    expect(sameLayout(one(at), { ...tree, elements: [...one(at).elements, ...one(at).elements] })).toBe(false);
  });
});

describe('swipeDirection', () => {
  it('moves the finger against the scroll', () => {
    expect(['up', 'down', 'left', 'right'].map((d) => swipeDirection(d as 'up'))).toEqual([
      'down',
      'up',
      'right',
      'left',
    ]);
  });
});

describe('HandsetDriver', () => {
  const envelope = (verb: string, data: unknown, error: unknown = null) =>
    JSON.stringify({ ok: error === null, verb, cid: `${verb}_1`, data, error });

  function fake(answers: Record<string, string>) {
    const calls: string[][] = [];
    const exec: HandsetExec = async (args) => {
      calls.push(args);
      const verb = args[0]!;
      const label = args[args.indexOf('--label') + 1];
      return answers[`${verb}:${label}`] ?? answers[verb] ?? envelope(verb, {});
    };
    return { calls, exec };
  }

  it('taps an observed element at its centre on the lease', async () => {
    const { calls, exec } = fake({ tree: envelope('tree', tree) });
    const driver = new HandsetDriver('ios', { lease: 'ls_1' }, exec);
    (driver as unknown as { lastObservation: unknown }).lastObservation = { elements: handsetElements(tree, 'ios') };
    const result = await driver.act({ kind: 'tap', ref: 'e2' });
    expect(result.ok).toBe(true);
    expect(calls.at(-1)).toEqual(['tap', '--lease', 'ls_1', '--x', '201', '--y', '452', '--json']);
    expect(result.step).toMatchObject({ kind: 'tap', target: { testId: 'dial-button' } });
  });

  /** Matet's layout editor: a metric card drawn over most of the ADD METRIC button. */
  const editor = (card: { y: number; height: number }): HandsetTree => ({
    ...tree,
    elements: [
      { ref: '@e1', type: 'Button', label: 'ADD METRIC', frame: { x: 20, y: 600, width: 362, height: 60 } },
      { ref: '@e2', type: 'StaticText', label: 'ADD METRIC', frame: { x: 150, y: 620, width: 102, height: 20 } },
      { ref: '@e3', type: 'Button', label: 'SPEED', frame: { x: 20, y: card.y, width: 362, height: card.height } },
    ],
  });
  const observed = (driver: HandsetDriver, observedTree: HandsetTree) => {
    (driver as unknown as { lastObservation: unknown }).lastObservation = {
      elements: handsetElements(observedTree, 'ios'),
    };
  };

  it('taps through a label inside the element at its centre', async () => {
    const { calls, exec } = fake({});
    const driver = new HandsetDriver('ios', { lease: 'ls_1' }, exec);
    observed(driver, editor({ y: 700, height: 80 }));
    expect((await driver.act({ kind: 'tap', ref: 'e1' })).ok).toBe(true);
    expect(calls.at(-1)).toEqual(['tap', '--lease', 'ls_1', '--x', '201', '--y', '630', '--json']);
  });

  it('taps the part that shows when another element covers the centre, and records that point', async () => {
    const { calls, exec } = fake({});
    const driver = new HandsetDriver('ios', { lease: 'ls_1' }, exec);
    observed(driver, editor({ y: 560, height: 80 }));
    const result = await driver.act({ kind: 'tap', ref: 'e1' });
    expect(result.ok).toBe(true);
    const tap = calls.at(-1)!;
    const [x, y] = [Number(tap[tap.indexOf('--x') + 1]), Number(tap[tap.indexOf('--y') + 1])];
    // The card ends at y 640; the button shows from there to 660.
    expect(x).toBe(201);
    expect(y).toBeGreaterThan(640);
    expect(y).toBeLessThan(660);
    expect(result.step).toMatchObject({ kind: 'tap', target: { name: 'ADD METRIC', point: { x, y } } });
  });

  it('refuses to tap an element that is hidden, and says what covers it', async () => {
    const { calls, exec } = fake({});
    const driver = new HandsetDriver('ios', { lease: 'ls_1' }, exec);
    observed(driver, editor({ y: 590, height: 80 }));
    const result = await driver.act({ kind: 'tap', ref: 'e1' });
    expect(result.ok).toBe(false);
    expect(result.retryable).toBeUndefined();
    expect(result.error).toContain('"ADD METRIC" is covered by "SPEED"');
    expect(calls.some((call) => call[0] === 'tap')).toBe(false);
  });

  it('replays a recorded locator by id before falling back to the point', async () => {
    const { calls, exec } = fake({
      'tap:dial-button': envelope('tap', null, { code: 'not_found', message: 'no element', lesson: null }),
      'tap:Dial': envelope('tap', {}),
    });
    const driver = new HandsetDriver('ios', { lease: 'ls_1' }, exec);
    const result = await driver.act({
      kind: 'tap',
      locator: { testId: 'dial-button', name: 'Dial', point: { x: 201, y: 452 } },
    });
    expect(result).toMatchObject({ ok: true });
    expect(result.degraded).toBeUndefined();
    expect(calls.map((call) => call[call.indexOf('--label') + 1])).toEqual(['dial-button', 'Dial']);
  });

  it('reports a Handset failure as the device, retryable, with the known fix', async () => {
    const { exec } = fake({
      swipe: envelope('swipe', null, {
        code: 'busy',
        message: 'a flow holds the driver',
        lesson: { fix: 'wait for the flow' },
      }),
    });
    const driver = new HandsetDriver('ios', { lease: 'ls_1' }, exec);
    const result = await driver.act({ kind: 'scroll', direction: 'down' });
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.error).toContain('device, not app');
    expect(result.error).toContain('wait for the flow');
  });

  /** A tree whose telemetry text ticks on every read, as Matet's HUD does while a wheel streams. */
  const live = (n: number, dialY = 418): HandsetTree => ({
    ...tree,
    elements: [
      {
        ref: '@e1',
        type: 'StaticText',
        label: `${(23.4 + n / 10).toFixed(1)} km/h`,
        // Centred text: its width and x follow the digits.
        frame: { x: 150.33 - (n % 2) * 1.5, y: 317.33, width: 101.33 + (n % 2) * 3, height: 76 },
      },
      { ref: '@e2', type: 'Other', value: `${40 + n}%`, frame: { x: 20, y: 120, width: 362.5, height: 80 } },
      { ref: '@e3', type: 'Button', label: 'Dial', frame: { x: 91, y: dialY, width: 220, height: 68 } },
    ],
  });

  function sequence(trees: HandsetTree[]) {
    let reads = 0;
    const exec: HandsetExec = async (args) => envelope(args[0]!, trees[Math.min(reads++, trees.length - 1)]);
    return exec;
  }

  it('settles when the layout holds, even while text and values tick', async () => {
    const exec = sequence([0, 1, 2, 3, 4, 5].map((n) => live(n)));
    const driver = new HandsetDriver('ios', { lease: 'ls_1' }, exec);
    expect(await driver.settle({ timeoutMs: 1000, intervalMs: 0 })).toEqual({ frames: 2, stable: true });
  });

  it("settles while Hum's sleep timer counts down every second", async () => {
    // A right-aligned countdown beside a fixed button: "10:00" then "9:59" is narrower, so x moves too.
    const timer = (seconds: number): HandsetTree => {
      const label = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
      const width = label.length * 11.5;
      return {
        ...tree,
        elements: [
          { type: 'StaticText', label: `Sleep in ${label}`, frame: { x: 360 - width, y: 140, width, height: 22 } },
          { type: 'Button', label: 'Stop timer', frame: { x: 20, y: 200, width: 362, height: 50 } },
        ],
      };
    };
    const exec = sequence([600, 599, 598, 597].map(timer));
    const driver = new HandsetDriver('ios', { lease: 'ls_1' }, exec);
    expect(await driver.settle({ timeoutMs: 1000, intervalMs: 0 })).toEqual({ frames: 2, stable: true });
  });

  it('waits while an element moves, and settles once it stops', async () => {
    const exec = sequence([600, 500, 420, 418, 418].map((y, n) => live(n, y)));
    const driver = new HandsetDriver('ios', { lease: 'ls_1' }, exec);
    expect(await driver.settle({ timeoutMs: 1000, intervalMs: 0 })).toEqual({ frames: 5, stable: true });
  });

  it('gives up at the timeout when the layout never holds', async () => {
    let n = 0;
    const exec: HandsetExec = async (args) => envelope(args[0]!, live(n, 400 + n++ * 10));
    const driver = new HandsetDriver('ios', { lease: 'ls_1' }, exec);
    const settled = await driver.settle({ timeoutMs: 50, intervalMs: 0 });
    expect(settled.stable).toBe(false);
    expect(settled.frames).toBeGreaterThan(1);
  });

  it('says plainly what Handset cannot do yet', async () => {
    const driver = new HandsetDriver('android', { lease: 'ls_1' }, fake({}).exec);
    expect(await driver.act({ kind: 'back' })).toEqual({
      ok: false,
      error: 'Handset has no key verb for Android back yet',
    });
    expect((await driver.act({ kind: 'open', url: 'matet://ride' })).ok).toBe(false);
  });
});
