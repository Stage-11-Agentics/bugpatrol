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

/** Hum's eq tab: each section header has a pill toggle, a Button with no label, at the end of its row. */
const hum: HandsetTree = {
  ...tree,
  elements: [
    { ref: '@e1', type: 'Other', frame: { x: 0, y: 380, width: 402, height: 300 } },
    { ref: '@e2', type: 'StaticText', label: 'NOTCH FILTER', frame: { x: 20, y: 412, width: 98, height: 14 } },
    { ref: '@e3', type: 'Button', label: '', frame: { x: 336, y: 406, width: 46, height: 26 } },
    { ref: '@e4', type: 'StaticText', label: 'frequency', frame: { x: 20, y: 446, width: 60, height: 13 } },
    { ref: '@e5', type: 'StaticText', label: 'BINAURAL BEATS', frame: { x: 20, y: 560, width: 120, height: 14 } },
    { ref: '@e6', type: 'Button', frame: { x: 336, y: 554, width: 46, height: 26 } },
    { ref: '@e7', type: 'Image', frame: { x: 30, y: 640, width: 20, height: 20 } },
    { ref: '@e8', type: 'Button', frame: { x: 180, y: 780, width: 40, height: 40 } },
  ],
};

describe('handsetElements with unnamed controls', () => {
  const elements = handsetElements(hum, 'ios');

  it('keeps a control with no name, named by the text on its row', () => {
    expect(elements.map((element) => [element.ref, element.role, element.name, element.near])).toEqual([
      ['e1', 'text', 'NOTCH FILTER', undefined],
      ['e2', 'button', '', 'NOTCH FILTER'],
      ['e3', 'text', 'frequency', undefined],
      ['e4', 'text', 'BINAURAL BEATS', undefined],
      ['e5', 'button', '', 'BINAURAL BEATS'],
      ['e6', 'button', '', undefined],
    ]);
    expect(elements[1]).toMatchObject({ interactive: true, box: { x: 336, y: 406, width: 46, height: 26 } });
  });

  it('drops a group or an image with no name, as before', () => {
    expect(elements.some((element) => element.role === 'group' || element.role === 'image')).toBe(false);
  });

  it("takes the row's leading label over a value or a state line beside it", () => {
    const near = (elements: HandsetTree['elements'], w = 402) =>
      handsetElements({ ...hum, w, elements }, 'ios')
        .filter((element) => !element.name)
        .map((element) => element.near);
    // Hum's noise header: the title, a subtitle that changes with the color, then the source toggle.
    expect(
      near([
        { type: 'StaticText', label: 'NOISE', frame: { x: 18, y: 100, width: 52, height: 16 } },
        { type: 'StaticText', label: 'blue · +3 dB/oct', frame: { x: 18, y: 119, width: 104, height: 13 } },
        { type: 'Button', frame: { x: 338, y: 104, width: 46, height: 26 } },
      ]),
    ).toEqual(['NOISE']);
    // A settings row: label, value, toggle. And two such pairs on one row.
    expect(
      near([
        { type: 'StaticText', label: 'Sleep timer', frame: { x: 20, y: 300, width: 90, height: 20 } },
        { type: 'StaticText', label: '12 min', frame: { x: 250, y: 300, width: 60, height: 20 } },
        { type: 'Button', frame: { x: 336, y: 297, width: 46, height: 26 } },
      ]),
    ).toEqual(['Sleep timer']);
    expect(
      near([
        { type: 'StaticText', label: 'Left', frame: { x: 20, y: 300, width: 40, height: 20 } },
        { type: 'Button', frame: { x: 140, y: 297, width: 46, height: 26 } },
        { type: 'StaticText', label: 'Right', frame: { x: 220, y: 300, width: 40, height: 20 } },
        { type: 'Button', frame: { x: 336, y: 297, width: 46, height: 26 } },
      ]),
    ).toEqual(['Left', 'Right']);
    // Its own label inside it; a checkbox before its label; text over another control's name.
    expect(
      near([
        { type: 'Button', frame: { x: 20, y: 300, width: 120, height: 40 } },
        { type: 'Image', label: 'play.fill', frame: { x: 30, y: 310, width: 20, height: 20 } },
        { type: 'Button', frame: { x: 200, y: 400, width: 26, height: 26 } },
        { type: 'StaticText', label: 'Agree', frame: { x: 236, y: 403, width: 60, height: 20 } },
        { type: 'StaticText', label: 'Notifications', frame: { x: 200, y: 470, width: 100, height: 20 } },
        { type: 'Button', frame: { x: 200, y: 500, width: 26, height: 26 } },
        { type: 'Button', label: 'Help', frame: { x: 240, y: 500, width: 40, height: 26 } },
      ]),
    ).toEqual(['play.fill', 'Agree', 'Notifications']);
  });

  it('takes a text before a leading icon, and breaks a near tie of left edges by tree order', () => {
    const near = (elements: HandsetTree['elements']) =>
      handsetElements({ ...hum, elements }, 'ios')
        .filter((element) => !element.name)
        .map((element) => element.near);
    expect(
      near([
        { type: 'Image', label: 'bell.fill', frame: { x: 20, y: 300, width: 24, height: 24 } },
        { type: 'StaticText', label: 'Notifications', frame: { x: 56, y: 302, width: 110, height: 20 } },
        { type: 'Switch', frame: { x: 330, y: 297, width: 51, height: 31 } },
      ]),
    ).toEqual(['Notifications']);
    expect(
      near([
        { type: 'StaticText', label: 'NOISE', frame: { x: 18, y: 100, width: 52, height: 16 } },
        { type: 'StaticText', label: 'blue · +3 dB/oct', frame: { x: 17.5, y: 119, width: 104, height: 13 } },
        { type: 'Button', frame: { x: 338, y: 104, width: 46, height: 26 } },
      ]),
    ).toEqual(['NOISE']);
  });

  it('reads Android labels as text, so a settings row names its switch by its label', () => {
    const row = handsetElements(
      {
        w: 1080,
        h: 2400,
        unit: 'tap',
        elements: [
          { type: 'android.widget.TextView', text: 'Sleep timer', frame: { x: 48, y: 800, width: 260, height: 50 } },
          { type: 'android.widget.TextView', text: '12 min', frame: { x: 640, y: 800, width: 140, height: 50 } },
          { type: 'android.widget.Switch', frame: { x: 900, y: 790, width: 130, height: 70 } },
          { type: 'android.widget.EditText', text: 'Rain', frame: { x: 48, y: 1000, width: 980, height: 100 } },
        ],
      },
      'android',
    );
    expect(row.map((element) => [element.role, element.name || element.near])).toEqual([
      ['text', 'Sleep timer'],
      ['text', '12 min'],
      ['switch', 'Sleep timer'],
      ['textbox', 'Rain'],
    ]);
  });

  it('reaches the next row by a share of the screen, since Android tap units are pixels', () => {
    const android = handsetElements(
      {
        w: 1080,
        h: 2400,
        unit: 'tap',
        elements: [
          { type: 'android.widget.Button', frame: { x: 900, y: 1000, width: 120, height: 70 } },
          { type: 'android.widget.TextView', text: 'Volume', frame: { x: 880, y: 1170, width: 160, height: 40 } },
        ],
      },
      'android',
    );
    expect(android[0]!.near).toBe('Volume');
  });

  it('keeps an unnamed cell that holds nothing named, such as a swatch in a grid', () => {
    const grid = handsetElements(
      {
        ...hum,
        elements: [
          { type: 'CollectionView', frame: { x: 0, y: 100, width: 402, height: 200 } },
          { type: 'Cell', frame: { x: 20, y: 120, width: 80, height: 80 } },
          { type: 'Image', frame: { x: 30, y: 130, width: 60, height: 60 } },
          { type: 'Cell', frame: { x: 110, y: 120, width: 80, height: 80 } },
          { type: 'android.google.material.tabs.TabLayout', frame: { x: 0, y: 790, width: 402, height: 60 } },
          { type: 'android.widget.TextView', text: 'Rides', frame: { x: 20, y: 800, width: 100, height: 40 } },
        ],
      },
      'ios',
    );
    expect(grid.map((element) => [element.role, element.name, element.box.x])).toEqual([
      ['button', '', 20],
      ['button', '', 110],
      ['text', 'Rides', 20],
    ]);
  });

  it('drops an unnamed table, tab bar or cell: its controls and texts name themselves', () => {
    const holders = handsetElements(
      {
        ...hum,
        elements: [
          { type: 'Table', frame: { x: 0, y: 100, width: 402, height: 600 } },
          { type: 'Cell', frame: { x: 0, y: 100, width: 402, height: 60 } },
          { type: 'StaticText', label: 'Morning ride', frame: { x: 20, y: 120, width: 120, height: 20 } },
          { type: 'TabBar', frame: { x: 0, y: 790, width: 402, height: 84 } },
          { type: 'Button', label: 'History', frame: { x: 0, y: 790, width: 134, height: 50 } },
        ],
      },
      'ios',
    );
    expect(holders.map((element) => element.name)).toEqual(['Morning ride', 'History']);
  });

  it('takes the text on the row above or below when its own row has none', () => {
    const below = handsetElements(
      {
        ...hum,
        elements: [
          { type: 'Button', frame: { x: 336, y: 406, width: 46, height: 26 } },
          { type: 'StaticText', label: 'far below', frame: { x: 20, y: 500, width: 60, height: 13 } },
          { type: 'StaticText', label: 'volume', frame: { x: 330, y: 440, width: 60, height: 13 } },
        ],
      },
      'ios',
    );
    expect(below[0]!.near).toBe('volume');
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

  it('taps a control with no name by its ref, at its centre, and records the point for replay', async () => {
    const { calls, exec } = fake({});
    const driver = new HandsetDriver('ios', { lease: 'ls_1' }, exec);
    (driver as unknown as { lastObservation: unknown }).lastObservation = { elements: handsetElements(hum, 'ios') };
    const result = await driver.act({ kind: 'tap', ref: 'e2' });
    expect(result.ok).toBe(true);
    expect(calls.at(-1)).toEqual(['tap', '--lease', 'ls_1', '--x', '359', '--y', '419', '--json']);
    expect(result.step).toMatchObject({ kind: 'tap', target: { role: 'button', point: { x: 359, y: 419 } } });
  });

  it('names a covered control with no name by the text on its row', async () => {
    const { exec } = fake({});
    const driver = new HandsetDriver('ios', { lease: 'ls_1' }, exec);
    const covered = structuredClone(hum);
    covered.elements.push({ type: 'Button', label: 'Done', frame: { x: 300, y: 380, width: 102, height: 80 } });
    (driver as unknown as { lastObservation: unknown }).lastObservation = {
      elements: handsetElements(covered, 'ios'),
    };
    const result = await driver.act({ kind: 'tap', ref: 'e2' });
    expect(result.error).toContain('Not tapped: the unnamed button near "NOTCH FILTER" is covered by "Done"');
  });

  it('taps a text through the unnamed button drawn over it, which is its own control', async () => {
    const { calls, exec } = fake({});
    const driver = new HandsetDriver('ios', { lease: 'ls_1' }, exec);
    (driver as unknown as { lastObservation: unknown }).lastObservation = {
      elements: handsetElements(
        {
          ...hum,
          elements: [
            { type: 'StaticText', label: 'Rain', frame: { x: 40, y: 300, width: 60, height: 20 } },
            { type: 'Button', frame: { x: 20, y: 290, width: 362, height: 40 } },
          ],
        },
        'ios',
      ),
    };
    expect((await driver.act({ kind: 'tap', ref: 'e1' })).ok).toBe(true);
    expect(calls.at(-1)).toEqual(['tap', '--lease', 'ls_1', '--x', '70', '--y', '310', '--json']);
  });

  it('does not tap a control through an unnamed scrim drawn over it', async () => {
    const { calls, exec } = fake({});
    const driver = new HandsetDriver('ios', { lease: 'ls_1' }, exec);
    (driver as unknown as { lastObservation: unknown }).lastObservation = {
      elements: handsetElements(
        {
          ...hum,
          elements: [
            { type: 'Button', label: 'Delete', frame: { x: 20, y: 400, width: 362, height: 44 } },
            { type: 'Button', frame: { x: 0, y: 60, width: 402, height: 560 } },
          ],
        },
        'ios',
      ),
    };
    const result = await driver.act({ kind: 'tap', ref: 'e1' });
    expect(result.error).toContain('"Delete" is covered by the unnamed button');
    expect(calls.some((call) => call[0] === 'tap')).toBe(false);
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
    expect(result.retryable).toBe(false);
    expect(result.error).toContain('"ADD METRIC" is covered by "SPEED"');
    expect(calls.some((call) => call[0] === 'tap')).toBe(false);
  });

  it('taps the centre when a later container that is not a control holds the element', async () => {
    const { calls, exec } = fake({});
    const driver = new HandsetDriver('ios', { lease: 'ls_1' }, exec);
    const editorTree = editor({ y: 700, height: 80 });
    editorTree.elements.push({
      type: 'ScrollView',
      id: 'layout-list',
      frame: { x: 0, y: 80, width: 402, height: 700 },
    });
    observed(driver, editorTree);
    expect((await driver.act({ kind: 'tap', ref: 'e1' })).ok).toBe(true);
    expect(calls.at(-1)).toEqual(['tap', '--lease', 'ls_1', '--x', '201', '--y', '630', '--json']);
  });

  it('does not type into a field under the software keyboard', async () => {
    const keys = 'qwertyuiopasdfghjklzxcvbnm'.split('').map((key, index) => ({
      type: 'Button',
      label: key,
      frame: { x: (index % 10) * 40, y: 600 + Math.floor(index / 10) * 50, width: 38, height: 46 },
    }));
    const { calls, exec } = fake({});
    const driver = new HandsetDriver('ios', { lease: 'ls_1' }, exec);
    observed(driver, {
      ...tree,
      elements: [{ type: 'TextField', label: 'Wheel name', frame: { x: 20, y: 650, width: 362, height: 40 } }, ...keys],
    });
    const result = await driver.act({ kind: 'type', ref: 'e1', value: 'Zippy' });
    expect(result.error).toContain('"Wheel name" is covered by "Software keyboard (open)"');
    expect(calls).toEqual([]);
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

  /** An observation of a 402x874-point screen, the size Handset's tree reports. */
  const screen = (driver: HandsetDriver) => {
    (driver as unknown as { lastObservation: unknown }).lastObservation = {
      elements: handsetElements(hum, 'ios'),
      viewport: { width: 402, height: 874, scale: 3 },
    };
  };

  it("drags from a point in the finger's direction, for a drawn slider that is in no tree", async () => {
    const { calls, exec } = fake({});
    const driver = new HandsetDriver('ios', { lease: 'ls_1' }, exec);
    screen(driver);
    const result = await driver.act({ kind: 'drag', from: { x: 40, y: 640 }, direction: 'right', distance: 120 });
    expect(result.ok).toBe(true);
    expect(calls.at(-1)).toEqual([
      'swipe',
      '--lease',
      'ls_1',
      '--direction',
      'right',
      '--x',
      '40',
      '--y',
      '640',
      '--distance',
      '120',
      '--json',
    ]);
    expect(result.step).toEqual({ kind: 'drag', from: { x: 40, y: 640 }, direction: 'right', distance: 120 });
    // A point, not an element: a replay cannot check that the control is still there.
    expect(result.degraded).toBe(true);
  });

  it('taps an explicit point in tap units, and refuses a point or a drag that leaves the screen', async () => {
    const { calls, exec } = fake({});
    const driver = new HandsetDriver('ios', { lease: 'ls_1' }, exec);
    screen(driver);
    expect((await driver.act({ kind: 'tap', locator: { point: { x: 120, y: 640 } } })).ok).toBe(true);
    expect(calls.at(-1)).toEqual(['tap', '--lease', 'ls_1', '--x', '120', '--y', '640', '--json']);
    const sent = calls.length;
    const outside = await driver.act({ kind: 'tap', locator: { point: { x: 1206, y: 640 } } });
    expect(outside).toMatchObject({ ok: false, retryable: false });
    expect(outside.error).toContain('outside the 402x874 screen, in the units of the element boxes');
    const far = await driver.act({ kind: 'drag', from: { x: 300, y: 640 }, direction: 'right', distance: 200 });
    expect(far).toMatchObject({ ok: false, retryable: false });
    expect(far.error).toContain('at most 101 to the right');
    const high = await driver.act({ kind: 'drag', from: { x: 200, y: 50 }, direction: 'up', distance: 60 });
    expect(high.error).toContain('at most 50 up');
    const low = await driver.act({ kind: 'drag', from: { x: 200, y: 800 }, direction: 'down', distance: 74 });
    expect(low.error).toContain('at most 73 down');
    expect(calls).toHaveLength(sent);
  });

  /**
   * Hum's eq tab. The band sliders, the notch frequency slider and the beat
   * slider are drawn shapes with drag gestures: they are in no tree. Only the
   * test knows where they are.
   */
  type Area = { x: number; y: number; width: number; height: number };
  const text = (label: string, x: number, y: number, width = 60): HandsetTree['elements'][number] => ({
    type: 'StaticText',
    label,
    frame: { x, y, width, height: 13 },
  });
  const eq: HandsetTree = {
    w: 402,
    h: 874,
    unit: 'tap',
    elements: [
      { type: 'ScrollView', frame: { x: 0, y: 54, width: 402, height: 730 } },
      text('FIVE BAND', 18, 120, 90),
      ...[30, 100, 170, 240, 310].map((x) => text('+0.0', x, 150, 40)),
      ...['60', '230', '910', '3.6k', '14k'].map((label, index) => text(label, 36 + index * 70, 308, 28)),
      text('NOTCH FILTER', 18, 350, 98),
      { type: 'Button', frame: { x: 338, y: 344, width: 46, height: 26 } },
      text('frequency', 18, 390),
      text('1.2 kHz', 330, 390, 52),
      text('BINAURAL BEATS', 18, 470, 120),
      { type: 'Button', frame: { x: 338, y: 464, width: 46, height: 26 } },
      ...['delta', 'theta', 'alpha', 'beta', 'gamma'].map((label, index) => ({
        type: 'Button',
        label,
        frame: { x: 18 + index * 74, y: 510, width: 66, height: 30 },
      })),
      text('beat', 18, 560, 40),
      text('10 Hz', 340, 560, 42),
      text('carrier', 18, 630, 50),
      text('200 Hz', 330, 630, 52),
      ...['noise', 'eq', 'nature'].map((label, index) => ({
        type: 'Button',
        label,
        frame: { x: index * 134, y: 790, width: 134, height: 50 },
      })),
    ],
  };
  const eqDrawn: Area[] = [
    { x: 18, y: 172, width: 366, height: 128 },
    { x: 18, y: 410, width: 366, height: 24 },
    { x: 18, y: 580, width: 366, height: 24 },
    { x: 18, y: 650, width: 366, height: 24 },
  ];
  /** Hum's noise tab: the orb knob is drawn in the middle of the screen, in no tree. */
  const noise: HandsetTree = {
    ...eq,
    elements: [
      { type: 'ScrollView', frame: { x: 0, y: 54, width: 402, height: 730 } },
      text('NOISE', 18, 100, 52),
      text('blue · +3 dB/oct', 18, 119, 104),
      { type: 'Button', frame: { x: 338, y: 104, width: 46, height: 26 } },
      // The knob draws its color and slope at its centre.
      text('blue', 186, 420, 30),
      text('+3 dB/oct', 170, 440, 62),
      ...['brown', 'pink', 'white', 'blue', 'violet'].map((label, index) => ({
        type: 'Button',
        label,
        frame: { x: 18 + index * 74, y: 560, width: 66, height: 30 },
      })),
      text('modulation', 18, 620, 90),
      text('rate', 18, 660, 30),
      text('0.2 Hz', 330, 660, 52),
      ...eq.elements.slice(-3),
    ],
  };
  const noiseDrawn: Area[] = [
    { x: 101, y: 337, width: 200, height: 200 },
    { x: 18, y: 680, width: 366, height: 24 },
  ];

  /** A driver that has just observed `observed`, with the swipe it sends. */
  const looking = (observed: HandsetTree) => {
    const { calls, exec } = fake({});
    const driver = new HandsetDriver('ios', { lease: 'ls_1' }, exec);
    Object.assign(driver as unknown as Record<string, unknown>, {
      lastTree: observed,
      lastObservation: {
        elements: handsetElements(observed, 'ios'),
        viewport: { width: observed.w, height: observed.h, scale: 3 },
      },
    });
    const swipe = () => {
      const call = calls.find((args) => args[0] === 'swipe');
      if (!call) return undefined;
      const value = (flag: string) => (call.includes(flag) ? Number(call[call.indexOf(flag) + 1]) : undefined);
      return {
        direction: call[call.indexOf('--direction') + 1],
        x: value('--x'),
        y: value('--y'),
        distance: value('--distance'),
      };
    };
    return { driver, calls, swipe };
  };
  const within = (area: Area, x: number, y: number) =>
    x >= area.x && x <= area.x + area.width && y >= area.y && y <= area.y + area.height;
  const onElement = (observed: HandsetTree, x: number, y: number) =>
    handsetElements(observed, 'ios').some((element) => within(element.box, x, y));

  it("starts a scroll beside a label, not on the EQ band's label it was given, nor on a drawn slider", async () => {
    const { driver, swipe } = looking(eq);
    const band = handsetElements(eq, 'ios').find((element) => element.name === '60')!;
    expect((await driver.act({ kind: 'scroll', direction: 'down', ref: band.ref })).ok).toBe(true);
    const { direction, x, y, distance } = swipe()!;
    expect(direction).toBe('up');
    expect(x).toBeDefined();
    expect(eqDrawn.some((area) => within(area, x!, y!))).toBe(false);
    expect(onElement(eq, x!, y!)).toBe(false);
    // In the gap between a label and its value: on the carrier row, between "carrier" and "200 Hz".
    expect(y).toBeGreaterThanOrEqual(630);
    expect(y).toBeLessThanOrEqual(643);
    expect(x).toBeGreaterThan(68);
    expect(x).toBeLessThan(330);
    // The finger stays inside the scroll view.
    expect(distance).toBeGreaterThanOrEqual(60);
    expect(y! - distance!).toBeGreaterThanOrEqual(54);
  });

  it('looks past a named scroll view that covers the area, as Android lists a RecyclerView with an id', async () => {
    const named: HandsetTree = {
      ...eq,
      elements: [
        { type: 'ScrollView', id: 'eq-scroll', frame: { x: 0, y: 54, width: 402, height: 730 } },
        ...eq.elements.slice(1),
      ],
    };
    const { driver, swipe } = looking(named);
    const result = await driver.act({ kind: 'scroll', direction: 'down' });
    expect(result.note).toBeUndefined();
    const { x, y } = swipe()!;
    expect(eqDrawn.some((area) => within(area, x!, y!))).toBe(false);
    expect(y).toBeGreaterThanOrEqual(630);
    expect(y).toBeLessThanOrEqual(643);
  });

  it('starts a scroll with no ref away from the orb knob at the centre of the screen, in every direction', async () => {
    for (const direction of ['down', 'up', 'left', 'right'] as const) {
      const { driver, swipe } = looking(noise);
      expect((await driver.act({ kind: 'scroll', direction })).ok).toBe(true);
      const { x, y } = swipe()!;
      expect(x).toBeDefined();
      expect(noiseDrawn.some((area) => within(area, x!, y!))).toBe(false);
    }
  });

  /** Hum's nature tab: each row is a label, then a slider drawn to the end of the row. */
  const nature: HandsetTree = {
    ...eq,
    elements: [
      { type: 'ScrollView', frame: { x: 0, y: 54, width: 402, height: 730 } },
      text('NATURE', 18, 100, 60),
      text('3 active', 250, 100, 60),
      { type: 'Button', frame: { x: 338, y: 94, width: 46, height: 26 } },
      ...['rain', 'stream', 'ocean', 'thunder', 'wind', 'fire', 'birds', 'crickets', 'frogs', 'cafe', 'train'].map(
        (label, index) => text(label, 18, 160 + index * 50, 90),
      ),
      ...eq.elements.slice(-3),
    ],
  };
  const natureDrawn: Area[] = Array.from({ length: 11 }, (_, index) => ({
    x: 124,
    y: 154 + index * 50,
    width: 260,
    height: 24,
  }));

  it("starts a scroll on a label, not on the slider drawn beside it on Hum's nature tab", async () => {
    const { driver, swipe } = looking(nature);
    for (const direction of ['down', 'up'] as const) {
      expect((await driver.act({ kind: 'scroll', direction })).ok).toBe(true);
    }
    const { x, y } = swipe()!;
    expect(natureDrawn.some((area) => within(area, x!, y!))).toBe(false);
  });

  it('keeps a scroll off a slider in the tree', async () => {
    const slider: HandsetTree = {
      ...eq,
      elements: [
        { type: 'ScrollView', frame: { x: 0, y: 54, width: 402, height: 730 } },
        text('volume', 18, 600, 60),
        { type: 'Slider', label: 'Volume', frame: { x: 90, y: 590, width: 290, height: 34 } },
        text('balance', 18, 700, 60),
      ],
    };
    const { driver, swipe } = looking(slider);
    expect((await driver.act({ kind: 'scroll', direction: 'down' })).ok).toBe(true);
    const { x, y } = swipe()!;
    expect(within({ x: 82, y: 582, width: 306, height: 50 }, x!, y!)).toBe(false);
  });

  it('keeps a scroll off a place this session dragged, while the layout holds', async () => {
    const rate: HandsetTree = {
      ...eq,
      elements: [
        { type: 'ScrollView', frame: { x: 0, y: 54, width: 402, height: 730 } },
        text('rate', 18, 600, 60),
        text('0.2 Hz', 330, 600, 52),
      ],
    };
    const { driver, swipe, calls } = looking(rate);
    expect((await driver.act({ kind: 'scroll', direction: 'down' })).ok).toBe(true);
    const free = swipe()!;
    // The gap between "rate" and its value, nearest the ideal start.
    expect([free.x, free.y]).toEqual([200, 606]);
    expect((await driver.act({ kind: 'drag', from: { x: 200, y: 606 }, direction: 'right', distance: 80 })).ok).toBe(
      true,
    );
    calls.length = 0;
    await driver.act({ kind: 'scroll', direction: 'down' });
    const kept = swipe()!;
    expect(within({ x: 168, y: 574, width: 64, height: 64 }, kept.x!, kept.y!)).toBe(false);
    // The screen scrolled: the drawn control moved with it, and the place is forgotten.
    const scrolled = { ...rate, elements: [...rate.elements, text('footer', 18, 760, 60)] };
    (driver as unknown as { lastTree: HandsetTree }).lastTree = scrolled;
    calls.length = 0;
    await driver.act({ kind: 'scroll', direction: 'down' });
    expect([swipe()!.x, swipe()!.y]).toEqual([200, 606]);
  });

  it('chooses against the tree that the last settle read', async () => {
    const { calls, exec } = fake({ tree: envelope('tree', noise) });
    const driver = new HandsetDriver('ios', { lease: 'ls_1' }, exec);
    await driver.settle({ timeoutMs: 1000, intervalMs: 0 });
    expect((await driver.act({ kind: 'scroll', direction: 'down' })).ok).toBe(true);
    const call = calls.find((args) => args[0] === 'swipe')!;
    const [x, y] = [Number(call[call.indexOf('--x') + 1]), Number(call[call.indexOf('--y') + 1])];
    expect(noiseDrawn.some((area) => within(area, x, y))).toBe(false);
  });

  it('scales to an Android screen in pixels', async () => {
    const scale = 1080 / 402;
    const px = (area: Area): Area => ({
      x: area.x * scale,
      y: area.y * scale,
      width: area.width * scale,
      height: area.height * scale,
    });
    const android: HandsetTree = {
      w: 1080,
      h: 2348,
      unit: 'tap',
      elements: eq.elements.map((node) => ({ ...node, frame: node.frame && px(node.frame) })),
    };
    const { calls, exec } = fake({});
    const driver = new HandsetDriver('android', { lease: 'ls_1' }, exec);
    Object.assign(driver as unknown as Record<string, unknown>, {
      lastTree: android,
      lastObservation: {
        elements: handsetElements(android, 'android'),
        viewport: { width: 1080, height: 2348, scale: 1 },
      },
    });
    expect((await driver.act({ kind: 'scroll', direction: 'down' })).ok).toBe(true);
    const call = calls.find((args) => args[0] === 'swipe')!;
    const [x, y, distance] = ['--x', '--y', '--distance'].map((flag) => Number(call[call.indexOf(flag) + 1]));
    expect(eqDrawn.map(px).some((area) => within(area, x!, y!))).toBe(false);
    // Handset's Android travel is 30% of the screen, and the finger stays inside the scroll view.
    expect(distance).toBeLessThanOrEqual(Math.round(0.3 * 2348));
    expect(y! - distance!).toBeGreaterThanOrEqual(54 * scale);
  });

  it('scrolls a list from a row when the list has no empty space, and says so', async () => {
    const rows: HandsetTree = {
      ...eq,
      elements: [
        { type: 'Table', frame: { x: 0, y: 54, width: 402, height: 736 } },
        ...Array.from({ length: 16 }, (_, index) => ({
          type: 'Cell',
          label: `Ride ${index + 1}`,
          frame: { x: 0, y: 54 + index * 46, width: 402, height: 46 },
        })),
      ],
    };
    const { driver, swipe } = looking(rows);
    const result = await driver.act({ kind: 'scroll', direction: 'down' });
    expect(result.ok).toBe(true);
    expect(swipe()!.x).toBeDefined();
    expect(result.note).toMatch(/^The scroll started on "Ride \d+": the area to scroll has no empty space or text\.$/);
  });

  it('refuses a scroll when every point is on a control that follows a drag, and says how to scroll instead', async () => {
    const sliders: HandsetTree = {
      ...eq,
      elements: Array.from({ length: 20 }, (_, index) => ({
        type: 'Slider',
        label: `Band ${index + 1}`,
        frame: { x: 0, y: 54 + index * 40, width: 402, height: 40 },
      })),
    };
    const { driver, calls } = looking(sliders);
    const result = await driver.act({ kind: 'scroll', direction: 'down' });
    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(result.error).toContain('Not scrolled');
    expect(result.error).toContain('drag');
    expect(calls.some((call) => call[0] === 'swipe')).toBe(false);
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
