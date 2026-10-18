import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, type Issue, parseConfig, publisherOf } from '@bugpatrol/core';
import { afterEach, describe, expect, it } from 'vitest';
import { ghFor, ghReady } from '../github.js';
import { runPublisher } from '../roles/publish.js';
import type { Runtime } from '../types.js';
import { Workspace } from '../workspace.js';
import { closeFinding, publisherFor, syncFindings } from './index.js';
import { LatticePublisher, type LatticeRun } from './lattice.js';

let roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots = [];
});
const temp = async (name: string) => {
  const dir = await mkdtemp(join(tmpdir(), `bugpatrol-${name}-`));
  roots.push(dir);
  return dir;
};

const configFor = (lattice: Record<string, unknown> = {}) =>
  parseConfig({
    version: 1,
    app: { connect: { url: 'http://localhost' } },
    agents: { publisher: { use: 'lattice', issueMinSeverity: 'minor', lattice } },
  });

async function workspaceWith(root: string, patch: Partial<Issue> = {}) {
  const workspace = new Workspace(root);
  const shot = '.bugpatrol/runs/sessions/ses_1/001-look.png';
  await mkdir(join(root, '.bugpatrol/runs/sessions/ses_1'), { recursive: true });
  await writeFile(join(root, shot), 'png');
  const issue: Issue = {
    version: 1,
    id: 'iss_1',
    fingerprint: 'dd463fcef9ed5679',
    title: 'Noise header slope disagrees with the knob',
    body: 'What happened',
    severity: 'minor',
    status: 'new',
    candidateIds: [],
    evidence: { screenshot: shot, reproRoutineId: 'repro-1' },
    judgement: { by: 'judge', reason: 'Visible failure', at: 'now' },
    occurrences: 1,
    firstSeenAt: '2026-10-15T20:00:00Z',
    lastSeenAt: '2026-10-15T20:00:00Z',
    ...patch,
  };
  await workspace.saveIssue(issue);
  return { workspace, issue };
}

function publishingRuntime(): Runtime & { ran: number } {
  const runtime = {
    label: 'fake',
    ran: 0,
    async run(task: Parameters<Runtime['run']>[0]) {
      runtime.ran++;
      const publish = task.tools.find((tool) => tool.name === 'publish')!;
      const response = await publish.run({
        issue_id: 'iss_1',
        title: 'Noise header slope disagrees with the knob',
        summary: 'The header shows the named slope.',
      });
      expect(response.isError).toBe(false);
      return { stop: 'done' as const, steps: 1, costUsd: 0 };
    },
  };
  return runtime;
}

type FakeTask = {
  id: string;
  short_id: string;
  title: string;
  status: string;
  description: string;
  tags: string[];
  type?: string;
  priority?: string;
  last_status_changed_at: string;
  events: { type: string; provenance?: { reason?: string } }[];
  artifacts: { title: string; path: string }[];
  comments: string[];
};

/** The stage11 workflow's transitions that matter here: done and cancelled lead nowhere. */
const TRANSITIONS: Record<string, string[]> = {
  backlog: ['in_planning', 'planned', 'cancelled'],
  in_progress: ['review', 'blocked', 'cancelled'],
  done: [],
  cancelled: [],
};

/** An in-memory Lattice board that answers the CLI's verbs with its JSON envelope. */
function fakeLattice() {
  const tasks: FakeTask[] = [];
  const calls: string[][] = [];
  const ok = (data: unknown) => ({ code: 0, stdout: JSON.stringify({ ok: true, data }), stderr: '' });
  const fail = (code: string, message: string) => ({
    code: 1,
    stdout: JSON.stringify({ ok: false, error: { code, message } }),
    stderr: '',
  });
  const run: LatticeRun = async (args) => {
    calls.push(args);
    const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
    const find = (id: string) => tasks.find((task) => task.id === id || task.short_id === id);
    switch (args[0]) {
      case '--version':
        return { code: 0, stdout: 'lattice, version 0.2.3\n', stderr: '' };
      case 'list':
        return ok(tasks.filter((task) => task.tags.includes(flag('--tag')!)));
      case 'create': {
        const n = tasks.length + 1;
        const task: FakeTask = {
          id: `task_${n}`,
          short_id: `HUM-${n}`,
          title: args.at(-1)!,
          status: 'backlog',
          description: flag('--description') ?? '',
          tags: [flag('--tag')!],
          type: flag('--type'),
          priority: flag('--priority'),
          last_status_changed_at: new Date().toISOString(),
          events: [],
          artifacts: [],
          comments: [],
        };
        tasks.push(task);
        return ok(task);
      }
      case 'attach': {
        const task = find(args[1]!);
        if (!task) return fail('NOT_FOUND', 'no task');
        task.artifacts.push({ title: flag('--title')!, path: args[2]! });
        return ok({ id: `art_${task.artifacts.length}` });
      }
      case 'comment': {
        const task = find(args[1]!);
        if (!task) return fail('NOT_FOUND', 'no task');
        task.comments.push(readFileSync(flag('--file')!, 'utf8'));
        return ok(task);
      }
      case 'status': {
        const task = find(args[1]!);
        if (!task) return fail('NOT_FOUND', 'no task');
        const to = args[2]!;
        if (!(TRANSITIONS[task.status] ?? []).includes(to) && !args.includes('--force'))
          return fail('INVALID_TRANSITION', `Invalid transition from ${task.status} to ${to}.`);
        task.status = to;
        task.last_status_changed_at = new Date().toISOString();
        task.events.push({ type: 'status_changed', provenance: { reason: flag('--reason') } });
        return ok(task);
      }
      case 'show': {
        const task = find(args[1]!);
        return task ? ok(task) : fail('NOT_FOUND', 'no task');
      }
      default:
        return fail('UNKNOWN', args[0]!);
    }
  };
  /** A person moves a task, as the dashboard or the CLI would. */
  const person = (id: string, status: string, reason: string) => {
    const task = find(id)!;
    task.status = status;
    task.last_status_changed_at = new Date().toISOString();
    task.events.push({ type: 'status_changed', provenance: { reason } });
  };
  const find = (id: string) => tasks.find((task) => task.id === id || task.short_id === id);
  return { run, tasks, calls, person };
}

describe('the Lattice publisher', () => {
  it('is selected by agents.publisher.use, names its CLI, and refuses GitHub beside it', () => {
    const config = configFor({ bin: 'lattice-v2' });
    expect(publisherOf(config)).toBe('lattice');
    expect(config.agents.publisher.lattice).toMatchObject({
      bin: 'lattice-v2',
      actor: 'agent:bugpatrol',
      tag: 'bugpatrol',
      dismissedStatuses: ['cancelled', 'wont_do'],
    });
    expect(publisherFor('/tmp', config)?.name).toBe('lattice');
    expect(() =>
      parseConfig({
        version: 1,
        app: { connect: { url: 'http://localhost' } },
        agents: { publisher: { use: 'lattice' }, github: { enabled: true } },
      }),
    ).toThrow(ConfigError);
  });

  it('files a tagged task with the markers in its description and the screenshots as artifacts, once', async () => {
    const root = await temp('lattice-publish');
    const lattice = fakeLattice();
    const config = configFor();
    const { workspace } = await workspaceWith(root);
    expect(await ghReady(ghFor(config))).toMatchObject({ ok: false });
    const deps = {
      publisher: new LatticePublisher(root, config, { run: lattice.run }),
      createRuntime: publishingRuntime,
    };
    expect(await runPublisher(root, config, deps)).toMatchObject([{ issueId: 'iss_1', kind: 'issue', url: 'HUM-1' }]);
    const [task] = lattice.tasks;
    expect(task).toMatchObject({ tags: ['bugpatrol'], type: 'bug', priority: 'medium', status: 'backlog' });
    expect(task!.description).toContain('<!-- bugpatrol:fingerprint dd463fcef9ed5679 -->');
    expect(task!.description).toContain('<!-- bugpatrol:routine repro-1 -->');
    expect(task!.description).toContain('Attached to this task as ses_1/001-look.png.');
    expect(task!.artifacts).toEqual([
      { title: 'ses_1/001-look.png', path: join(root, '.bugpatrol/runs/sessions/ses_1/001-look.png') },
    ]);
    expect(
      lattice.calls
        .filter((args) => ['create', 'attach'].includes(args[0]!))
        .every((args) => args.includes('agent:bugpatrol')),
    ).toBe(true);
    expect((await workspace.readIssue('iss_1'))?.published?.lattice).toMatchObject({
      id: 'task_1',
      name: 'HUM-1',
      state: 'open',
    });
    const again = publishingRuntime();
    expect(await runPublisher(root, config, { ...deps, createRuntime: () => again })).toEqual([]);
    expect(again.ran).toBe(0);
    expect(lattice.tasks).toHaveLength(1);
  });

  it('dedupes from another machine, and keeps a task a person cancelled dismissed', async () => {
    const lattice = fakeLattice();
    const config = configFor();
    const first = await temp('lattice-machine-1');
    await workspaceWith(first);
    await runPublisher(first, config, {
      publisher: new LatticePublisher(first, config, { run: lattice.run }),
      createRuntime: publishingRuntime,
    });

    const second = await temp('lattice-machine-2');
    await workspaceWith(second);
    const runtime = publishingRuntime();
    expect(
      await runPublisher(second, config, {
        publisher: new LatticePublisher(second, config, { run: lattice.run }),
        createRuntime: () => runtime,
      }),
    ).toMatchObject([{ kind: 'linked', url: 'HUM-1' }]);
    expect(runtime.ran).toBe(0);
    expect(lattice.tasks).toHaveLength(1);

    lattice.person('HUM-1', 'cancelled', 'The header names the preset; by design.');
    const publisher = new LatticePublisher(first, config, { run: lattice.run });
    expect(await syncFindings(first, config, { publisher })).toEqual({ changed: ['iss_1'] });
    const workspace = new Workspace(first);
    expect(await workspace.readIssue('iss_1')).toMatchObject({
      status: 'dismissed',
      closedBy: { by: 'Lattice', reason: expect.stringContaining('by design') },
    });
    expect((await workspace.readTriage()).fingerprints.dd463fcef9ed5679).toMatchObject({ decision: 'dismissed' });

    const third = await temp('lattice-machine-3');
    await workspaceWith(third);
    expect(
      await runPublisher(third, config, {
        publisher: new LatticePublisher(third, config, { run: lattice.run }),
        createRuntime: publishingRuntime,
      }),
    ).toMatchObject([{ kind: 'linked' }]);
    expect((await new Workspace(third).readIssue('iss_1'))?.status).toBe('dismissed');
    expect(lattice.tasks).toHaveLength(1);
  });

  it('closes a fixed finding and reopens a regression as status moves, each with a comment, forced past the workflow', async () => {
    const root = await temp('lattice-close');
    const lattice = fakeLattice();
    const config = configFor();
    const publisher = new LatticePublisher(root, config, { run: lattice.run });
    const { workspace } = await workspaceWith(root);
    await runPublisher(root, config, { publisher, createRuntime: publishingRuntime });
    const fixed: Issue = {
      ...(await workspace.readIssue('iss_1'))!,
      status: 'fixed',
      closedBy: { by: 'Bugpatrol', reason: 'A recheck on main did not find it.', at: 'now' },
    };
    await workspace.saveIssue(fixed);
    await closeFinding(root, config, fixed, { publisher, evidence: 'Recheck: the header matches the knob.' });
    const [task] = lattice.tasks;
    expect(task!.status).toBe('done');
    expect(task!.comments.at(-1)).toContain('Recheck: the header matches the knob.');
    const moves = lattice.calls.filter((args) => args[0] === 'status');
    expect(moves.map((args) => args.includes('--force'))).toEqual([false, true]);

    await workspace.saveIssue({
      ...(await workspace.readIssue('iss_1'))!,
      status: 'new',
      regression: { at: '2026-10-17T10:00:00Z', fromStatus: 'fixed' },
      occurrences: 2,
    });
    const runtime = publishingRuntime();
    expect(await runPublisher(root, config, { publisher, createRuntime: () => runtime })).toMatchObject([
      { kind: 'reopened', url: 'HUM-1' },
    ]);
    expect(runtime.ran).toBe(0);
    expect(task!.status).toBe('backlog');
    expect(task!.comments.at(-1)).toContain('seen again');
    expect(lattice.tasks).toHaveLength(1);
  });

  it('never moves a task a person cancelled, and posts nothing on it', async () => {
    const root = await temp('lattice-human');
    const lattice = fakeLattice();
    const config = configFor();
    const publisher = new LatticePublisher(root, config, { run: lattice.run });
    const { workspace } = await workspaceWith(root);
    await runPublisher(root, config, { publisher, createRuntime: publishingRuntime });
    lattice.person('HUM-1', 'cancelled', 'Not a bug.');
    const logs: string[] = [];
    await closeFinding(
      root,
      config,
      { ...(await workspace.readIssue('iss_1'))!, status: 'fixed' },
      {
        publisher,
        onLog: (line) => logs.push(line),
      },
    );
    expect(lattice.tasks[0]).toMatchObject({ status: 'cancelled', comments: [] });
    expect(logs.join('\n')).toContain('set by a person');
  });

  it('runs the named CLI in the named directory, and says so when it cannot', async () => {
    const root = await temp('lattice-bin');
    const board = join(root, 'board');
    await mkdir(board);
    const bin = join(root, 'my-lattice');
    await writeFile(bin, `#!/bin/sh\npwd > '${join(root, 'cwd')}'\necho '{"ok":true,"data":[]}'\n`);
    await chmod(bin, 0o755);
    const publisher = new LatticePublisher(root, configFor({ bin, dir: 'board' }));
    expect(await publisher.filed()).toEqual({ findings: [], lines: [] });
    expect((await readFile(join(root, 'cwd'), 'utf8')).trim()).toMatch(/board$/);
    const missing = new LatticePublisher(root, configFor({ bin: join(root, 'no-such-lattice') }));
    expect(await missing.ready()).toMatchObject({ ok: false, reason: expect.stringContaining('no-such-lattice') });
  });
});

const hasLattice = spawnSync('lattice', ['--version'], { stdio: 'ignore' }).status === 0;

describe.skipIf(!hasLattice)('the Lattice publisher on a real board', () => {
  it('files, dedupes, and keeps a cancelled task dismissed, through the lattice CLI', { timeout: 60_000 }, async () => {
    const root = await temp('lattice-real');
    const board = join(root, 'board');
    await mkdir(board);
    execFileSync(
      'lattice',
      [
        'init',
        '--path',
        board,
        '--actor',
        'agent:bugpatrol',
        '--project-code',
        'HUM',
        '--project-name',
        'Hum test',
        '--preset',
        'stage11',
        '--no-setup-claude',
        '--no-setup-agents',
        '--no-seed',
      ],
      { stdio: 'ignore' },
    );
    const config = configFor({ dir: 'board' });
    const { workspace } = await workspaceWith(root);
    expect(await runPublisher(root, config, { createRuntime: publishingRuntime })).toMatchObject([
      { kind: 'issue', url: 'HUM-1' },
    ]);
    const list = () =>
      JSON.parse(
        execFileSync('lattice', ['list', '--tag', 'bugpatrol', '--include-archived', '--json'], {
          cwd: board,
          encoding: 'utf8',
        }),
      ).data as { short_id: string; status: string; description: string }[];
    expect(list()).toHaveLength(1);
    expect(list()[0]!.description).toContain('bugpatrol:fingerprint dd463fcef9ed5679');
    const shown = JSON.parse(execFileSync('lattice', ['show', 'HUM-1', '--json'], { cwd: board, encoding: 'utf8' }))
      .data as { artifact_info: unknown[] };
    expect(shown.artifact_info).toHaveLength(1);

    execFileSync(
      'lattice',
      ['status', 'HUM-1', 'cancelled', '--reason', 'By design.', '--actor', 'human:atin', '--json'],
      { cwd: board, stdio: 'ignore' },
    );
    expect(await syncFindings(root, config)).toEqual({ changed: ['iss_1'] });
    expect((await workspace.readIssue('iss_1'))?.status).toBe('dismissed');

    const second = await temp('lattice-real-2');
    await workspaceWith(second);
    const other = configFor({ dir: join(board) });
    expect(await runPublisher(second, other, { createRuntime: publishingRuntime })).toMatchObject([{ kind: 'linked' }]);
    expect((await new Workspace(second).readIssue('iss_1'))?.status).toBe('dismissed');
    expect(list()).toHaveLength(1);
  });
});
