import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BugpatrolConfig, type FixProposal, type Issue, parseConfig } from '@bugpatrol/core';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultGh, type Gh, ghFor } from '../github.js';
import { runPublisher } from '../roles/publish.js';
import type { Runtime } from '../types.js';
import { Workspace } from '../workspace.js';
import { GitHubPublisher } from './github.js';
import { closeFinding, type Finding, type Publisher } from './index.js';

let roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots = [];
});

const config = parseConfig({
  version: 1,
  app: { connect: { url: 'http://localhost' } },
  agents: { github: { enabled: true, repo: 'o/r' } },
});

async function fixture(patch: Partial<Issue> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bugpatrol-publisher-'));
  roots.push(root);
  const workspace = new Workspace(root);
  const issue: Issue = {
    version: 1,
    id: 'iss_1',
    fingerprint: 'fp1',
    title: 'Slope header disagrees with the knob',
    body: 'What happened',
    severity: 'major',
    status: 'new',
    candidateIds: [],
    evidence: {},
    judgement: { by: 'judge', reason: 'Visible failure', at: 'now' },
    occurrences: 1,
    firstSeenAt: 'now',
    lastSeenAt: 'now',
    ...patch,
  };
  await workspace.saveIssue(issue);
  return { root, workspace, issue };
}

/** An in-memory tracker: what a publisher must do, with no service behind it. */
function memoryPublisher(found: Finding[] = [], options: { forge?: boolean; unreadable?: boolean } = {}) {
  const calls: string[] = [];
  const findings = [...found];
  const refs = new Map<string, Finding>();
  const publisher: Publisher = {
    name: 'github',
    label: 'Memory',
    fingerprints: true,
    async ready() {
      return { ok: true };
    },
    async filed() {
      calls.push('filed');
      if (options.unreadable) throw new Error('the board is gone');
      return { findings, lines: findings.map((finding) => `- ${finding.name} [${finding.state}]: ${finding.title}`) };
    },
    ref(issue) {
      return refs.get(issue.id);
    },
    link(issue, finding) {
      refs.set(issue.id, { ...finding });
    },
    async images(_issueId, paths) {
      calls.push(`images ${paths.length}`);
      return new Map(paths.map((path) => [path, `memory:${path}`]));
    },
    async create(input) {
      calls.push(`create ${input.title}`);
      const finding: Finding = {
        id: String(findings.length + 1),
        name: `M-${findings.length + 1}`,
        title: input.title,
        url: `memory://${findings.length + 1}`,
        state: 'open',
        fingerprints: input.fingerprints,
      };
      findings.push(finding);
      return finding;
    },
    async close(issue, input) {
      calls.push(`close ${issue.id} ${input.as}: ${input.evidence}`);
      const ref = refs.get(issue.id);
      if (ref) ref.state = input.as;
    },
    async reopen(issue, evidence) {
      calls.push(`reopen ${issue.id}: ${evidence}`);
      const ref = refs.get(issue.id);
      if (ref) ref.state = 'open';
    },
    async sync() {
      calls.push('sync');
      return { changed: [] };
    },
    ...(options.forge
      ? {
          async openPr() {
            calls.push('openPr');
            return { number: 4, url: 'memory://pr/4' };
          },
        }
      : {}),
  };
  return { publisher, calls, findings };
}

function publishingRuntime(): Runtime & { ran: number } {
  const runtime = {
    label: 'fake',
    ran: 0,
    async run(task: Parameters<Runtime['run']>[0]) {
      runtime.ran++;
      const view = task.tools.find((tool) => tool.name === 'view_item')!;
      const publish = task.tools.find((tool) => tool.name === 'publish')!;
      await view.run({ issue_id: 'iss_1' });
      const response = await publish.run({
        issue_id: 'iss_1',
        title: 'Slope header disagrees with the knob',
        summary: 'The header shows the named slope, not the knob.',
      });
      expect(response.isError).toBe(false);
      return { stop: 'done' as const, steps: 2, costUsd: 0 };
    },
  };
  return runtime;
}

describe('the Publisher interface', () => {
  it('files a new issue once, through the selected publisher', async () => {
    const f = await fixture();
    const memory = memoryPublisher();
    const runtime = publishingRuntime();
    const deps = { publisher: memory.publisher, createRuntime: () => runtime };
    expect(await runPublisher(f.root, config, deps)).toMatchObject([
      { issueId: 'iss_1', kind: 'issue', url: 'memory://1' },
    ]);
    expect(memory.calls).toContain('create Slope header disagrees with the knob');
    expect((await f.workspace.readIssue('iss_1'))?.status).toBe('filed');
    expect(await runPublisher(f.root, config, deps)).toEqual([]);
    expect(memory.findings).toHaveLength(1);
  });

  it('links an issue to the finding with its fingerprint instead of filing it again, with no model', async () => {
    const f = await fixture();
    const memory = memoryPublisher([
      { id: '7', name: 'M-7', title: 'Old title', url: 'memory://7', state: 'open', fingerprints: ['fp1'] },
    ]);
    const runtime = publishingRuntime();
    expect(await runPublisher(f.root, config, { publisher: memory.publisher, createRuntime: () => runtime })).toEqual([
      { issueId: 'iss_1', kind: 'linked', url: 'memory://7' },
    ]);
    expect(runtime.ran).toBe(0);
    expect(memory.findings).toHaveLength(1);
    expect(memory.publisher.ref(f.issue)).toMatchObject({ id: '7', state: 'open' });
    expect((await f.workspace.readIssue('iss_1'))?.status).toBe('filed');
  });

  it('keeps a dismissed finding dismissed: the matching issue is dismissed and its fingerprint triaged', async () => {
    const f = await fixture();
    const memory = memoryPublisher([
      { id: '7', name: 'M-7', title: 'Timer runs', url: 'memory://7', state: 'dismissed', fingerprints: ['fp1'] },
    ]);
    const runtime = publishingRuntime();
    expect(await runPublisher(f.root, config, { publisher: memory.publisher, createRuntime: () => runtime })).toEqual([
      { issueId: 'iss_1', kind: 'linked', url: 'memory://7' },
    ]);
    expect(runtime.ran).toBe(0);
    const issue = await f.workspace.readIssue('iss_1');
    expect(issue).toMatchObject({ status: 'dismissed', closedBy: { by: 'Memory' } });
    expect((await f.workspace.readTriage()).fingerprints.fp1).toMatchObject({ decision: 'dismissed' });
    expect((await f.workspace.readMemory()).lessons.some((lesson) => lesson.text.startsWith('Not a bug'))).toBe(true);
  });

  it('reopens the finding of a regression with evidence, with no model', async () => {
    const f = await fixture({
      status: 'new',
      regression: { at: '2026-10-17T10:00:00Z', fromStatus: 'fixed' },
      occurrences: 2,
    });
    const memory = memoryPublisher();
    memory.publisher.link(f.issue, { id: '7', name: 'M-7', title: 't', url: 'memory://7', state: 'fixed' });
    const runtime = publishingRuntime();
    expect(await runPublisher(f.root, config, { publisher: memory.publisher, createRuntime: () => runtime })).toEqual([
      { issueId: 'iss_1', kind: 'reopened', url: 'memory://7' },
    ]);
    expect(runtime.ran).toBe(0);
    expect(memory.calls.find((call) => call.startsWith('reopen'))).toContain('seen again');
    expect((await f.workspace.readIssue('iss_1'))?.status).toBe('filed');
  });

  it('files a verified fix as an issue when the publisher has no forge for its PR', async () => {
    const f = await fixture();
    const fix: FixProposal = {
      version: 1,
      id: 'fix_1',
      issueId: 'iss_1',
      status: 'verified',
      runtime: 'fake',
      repo: '',
      branch: 'fix',
      worktree: '',
      startedAt: 'now',
    };
    await f.workspace.saveFix(fix);
    const memory = memoryPublisher();
    const logs: string[] = [];
    expect(
      await runPublisher(f.root, config, {
        publisher: memory.publisher,
        createRuntime: publishingRuntime,
        onLog: (line) => logs.push(line),
      }),
    ).toMatchObject([{ issueId: 'iss_1', kind: 'issue' }]);
    expect(memory.calls).not.toContain('openPr');
    expect(logs.join('\n')).toContain('cannot open PRs');
  });

  it('matches by a candidate fingerprint too, preferring the open finding', async () => {
    const f = await fixture();
    const session = await f.workspace.startSession('explorer');
    await f.workspace.appendCandidate(session.id, {
      id: 'can_1',
      sessionId: session.id,
      source: 'explorer',
      fingerprint: 'fp-old',
      summary: 'Slope header disagrees',
      severity: 'major',
      evidence: {},
      createdAt: 'now',
    });
    await f.workspace.saveIssue({ ...f.issue, candidateIds: ['can_1'] });
    const memory = memoryPublisher([
      {
        id: '6',
        name: 'M-6',
        title: 'Old',
        url: 'memory://6',
        state: 'fixed',
        stateAt: '2026-10-01',
        fingerprints: ['fp-old'],
      },
      {
        id: '7',
        name: 'M-7',
        title: 'Old',
        url: 'memory://7',
        state: 'open',
        stateAt: '2026-09-01',
        fingerprints: ['fp-old'],
      },
    ]);
    const runtime = publishingRuntime();
    expect(await runPublisher(f.root, config, { publisher: memory.publisher, createRuntime: () => runtime })).toEqual([
      { issueId: 'iss_1', kind: 'linked', url: 'memory://7' },
    ]);
  });

  it('files nothing when a fingerprint publisher cannot list what it filed', async () => {
    const f = await fixture();
    const memory = memoryPublisher([], { unreadable: true });
    const runtime = publishingRuntime();
    const logs: string[] = [];
    expect(
      await runPublisher(f.root, config, {
        publisher: memory.publisher,
        createRuntime: () => runtime,
        onLog: (line) => logs.push(line),
      }),
    ).toEqual([]);
    expect(runtime.ran).toBe(0);
    expect(logs.join('\n')).toContain('the board is gone');
    expect((await f.workspace.readIssue('iss_1'))?.status).toBe('new');
  });

  it('drafts a dry run with no publisher configured', async () => {
    const f = await fixture();
    const off = parseConfig({ version: 1, app: { connect: { url: 'http://localhost' } } });
    expect(await runPublisher(f.root, off, { createRuntime: publishingRuntime, dryRun: true })).toMatchObject([
      { kind: 'issue' },
    ]);
    expect(await readFile(join(f.root, '.bugpatrol/runs/publish/iss_1.md'), 'utf8')).toContain('## What happened');
  });

  it('closes the finding as fixed or dismissed, with the evidence', async () => {
    const f = await fixture({
      status: 'fixed',
      closedBy: { by: 'Bugpatrol', reason: 'A recheck on main did not find it.', at: 'now' },
    });
    const memory = memoryPublisher();
    memory.publisher.link(f.issue, { id: '7', name: 'M-7', title: 't', url: 'memory://7', state: 'open' });
    await closeFinding(f.root, config, f.issue, { publisher: memory.publisher, evidence: 'Retest: fixed.' });
    expect(memory.calls).toEqual(['close iss_1 fixed: A recheck on main did not find it.\n\nRetest: fixed.']);
    expect((await f.workspace.readIssue('iss_1'))?.status).toBe('fixed');
    const dismissed = { ...f.issue, status: 'dismissed' as const };
    await closeFinding(f.root, config, dismissed, { publisher: memory.publisher });
    expect(memory.calls.at(-1)).toMatch(/^close iss_1 dismissed/);
  });
});

describe('GitHubPublisher', () => {
  const issue = (github?: Issue['github']): Issue => ({
    version: 1,
    id: 'iss_1',
    fingerprint: 'fp1',
    title: 't',
    body: 'b',
    severity: 'major',
    status: 'filed',
    candidateIds: [],
    evidence: {},
    judgement: { by: 'judge', reason: 'r', at: 'now' },
    occurrences: 1,
    firstSeenAt: 'now',
    lastSeenAt: 'now',
    github,
  });
  const fake =
    (calls: string[][]): Gh =>
    async (args) => {
      calls.push(args);
      return args[0] === 'repo' ? 'main' : '';
    };

  it('reads issue.github as the finding, and keeps a closed state when it links one', () => {
    const publisher = new GitHubPublisher('/tmp', config, fake([]));
    expect(publisher.ref(issue())).toBeUndefined();
    const closed = issue({ number: 8, url: 'u', at: 'now', state: 'closed', stateReason: 'not_planned' });
    expect(publisher.ref(closed)).toMatchObject({ id: '8', name: '#8', state: 'dismissed' });
    const linked = issue();
    publisher.link(linked, { id: '9', name: '#9', title: 't', url: 'u9', state: 'fixed', stateAt: 'then' });
    expect(linked.github).toMatchObject({ number: 9, state: 'closed', stateReason: 'completed', stateAt: 'then' });
  });

  it('closes and reopens with the evidence as the comment, and records the state', async () => {
    const calls: string[][] = [];
    const publisher = new GitHubPublisher('/tmp', config, fake(calls));
    const filed = issue({ number: 8, url: 'u', at: 'now' });
    await publisher.close(filed, { as: 'fixed', evidence: 'Recheck passed.' });
    expect(calls.at(-1)).toEqual([
      'issue',
      'close',
      '8',
      '--repo',
      'o/r',
      '--comment',
      'Recheck passed.',
      '--reason',
      'completed',
    ]);
    expect(publisher.ref(filed)?.state).toBe('fixed');
    await publisher.reopen(filed, 'Seen again.');
    expect(calls.at(-1)).toEqual(['issue', 'reopen', '8', '--repo', 'o/r', '--comment', 'Seen again.']);
    expect(publisher.ref(filed)?.state).toBe('open');
  });
});

describe('ghFor', () => {
  it('gives GitHub configs the gh CLI', () => {
    expect(ghFor(config)).toBe(defaultGh);
  });

  it('gives a config that names another publisher a gh that refuses without running anything', async () => {
    const other = {
      ...config,
      agents: { ...config.agents, github: { ...config.agents.github, enabled: false }, publisher: { use: 'file' } },
    } as unknown as BugpatrolConfig;
    await expect(ghFor(other)(['--version'])).rejects.toThrow(/agents\.publisher\.use is file/);
  });

  it('is the only way the source starts gh', async () => {
    const packages = join(dirname(fileURLToPath(import.meta.url)), '../../..');
    const spawns: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!['node_modules', 'dist'].includes(entry.name)) await walk(path);
        } else if (/\.tsx?$/.test(entry.name) && !entry.name.includes('.test.')) {
          const text = await readFile(path, 'utf8');
          if (/(execFile|execFileSync|spawn|spawnSync|exec)\(\s*'gh'/.test(text)) spawns.push(relative(packages, path));
        }
      }
    };
    await walk(packages);
    // github.ts holds defaultGh; doctor's check runs only when agents.github is on.
    expect(spawns.sort()).toEqual(['agents/src/github.ts', 'cli/src/commands/doctor.ts']);
  });
});
