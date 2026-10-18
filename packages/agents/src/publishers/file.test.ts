import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, type Issue, parseConfig, publisherOf } from '@bugpatrol/core';
import { afterEach, describe, expect, it } from 'vitest';
import { ghFor, ghReady } from '../github.js';
import { watchCi } from '../roles/ci.js';
import { runPublisher } from '../roles/publish.js';
import type { Runtime } from '../types.js';
import { Workspace } from '../workspace.js';
import type { FindingFile } from './file.js';
import { closeFinding, publisherFor, syncFindings } from './index.js';

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

const configFor = (dir: string) =>
  parseConfig({
    version: 1,
    app: { connect: { url: 'http://localhost' } },
    agents: { publisher: { use: 'file', issueMinSeverity: 'minor', file: { dir } } },
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

async function findings(dir: string): Promise<FindingFile[]> {
  const names = (await readdir(dir)).filter((name) => name.endsWith('.json'));
  return Promise.all(names.map(async (name) => JSON.parse(await readFile(join(dir, name), 'utf8')) as FindingFile));
}

describe('the file publisher', () => {
  it('is selected by agents.publisher.use, and refuses GitHub beside it', () => {
    expect(publisherOf(configFor('findings'))).toBe('file');
    expect(publisherFor('/tmp', configFor('findings'))?.name).toBe('file');
    expect(() =>
      parseConfig({
        version: 1,
        app: { connect: { url: 'http://localhost' } },
        agents: { publisher: { use: 'file' }, github: { enabled: true } },
      }),
    ).toThrow(ConfigError);
  });

  it('never starts gh: publish, sync, close, CI and the gh check all stay away from it', async () => {
    const root = await temp('file-nogh');
    const dir = join(root, 'findings');
    const config = configFor(dir);
    const { issue } = await workspaceWith(root);
    // A gh on the PATH that records every start.
    const bin = await temp('fake-gh');
    const log = join(bin, 'gh.log');
    await writeFile(join(bin, 'gh'), `#!/bin/sh\necho "$@" >> '${log}'\n`);
    await chmod(join(bin, 'gh'), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      await runPublisher(root, config, { createRuntime: publishingRuntime });
      await syncFindings(root, config);
      await closeFinding(root, config, { ...issue, status: 'dismissed' }, { onLog: () => {} });
      expect(await watchCi(root, config)).toEqual({ problems: [] });
      expect(await ghReady(ghFor(config))).toMatchObject({ ok: false, reason: expect.stringContaining('use is file') });
    } finally {
      process.env.PATH = path;
    }
    await expect(readFile(log, 'utf8')).rejects.toThrow(/ENOENT/);
  });

  it('files one JSON file per finding, with the fingerprints, the markers and the screenshots, once', async () => {
    const root = await temp('file-publish');
    const dir = join(root, 'findings');
    const config = configFor(dir);
    const { workspace } = await workspaceWith(root);
    expect(await runPublisher(root, config, { createRuntime: publishingRuntime })).toMatchObject([
      { issueId: 'iss_1', kind: 'issue', url: join(dir, 'dd463fcef9ed5679.json') },
    ]);
    const [file] = await findings(dir);
    expect(file).toMatchObject({
      id: 'dd463fcef9ed5679',
      status: 'open',
      fingerprints: ['dd463fcef9ed5679'],
      routine: 'repro-1',
      issueId: 'iss_1',
    });
    expect(file!.body).toContain('<!-- bugpatrol:fingerprint dd463fcef9ed5679 -->');
    expect(file!.body).toContain('<!-- bugpatrol:routine repro-1 -->');
    expect(file!.screenshots).toHaveLength(1);
    expect(await readFile(join(dir, file!.screenshots[0]!), 'utf8')).toBe('png');
    expect((await workspace.readIssue('iss_1'))?.published?.file).toMatchObject({
      id: 'dd463fcef9ed5679',
      state: 'open',
    });
    const again = publishingRuntime();
    expect(await runPublisher(root, config, { createRuntime: () => again })).toEqual([]);
    expect(again.ran).toBe(0);
    expect(await findings(dir)).toHaveLength(1);
  });

  it('dedupes from another machine by fingerprint, and keeps a dismissed finding dismissed', async () => {
    const shared = await temp('file-shared');
    const first = await temp('file-machine-1');
    await workspaceWith(first);
    await runPublisher(first, configFor(shared), { createRuntime: publishingRuntime });

    // Another machine, with no record of the finding, sees the same bug.
    const second = await temp('file-machine-2');
    await workspaceWith(second, { id: 'iss_1' });
    const runtime = publishingRuntime();
    expect(await runPublisher(second, configFor(shared), { createRuntime: () => runtime })).toMatchObject([
      { kind: 'linked' },
    ]);
    expect(runtime.ran).toBe(0);
    expect(await findings(shared)).toHaveLength(1);

    // A person dismisses it in the file. The sync dismisses the issue and triages its fingerprint.
    const path = join(shared, 'dd463fcef9ed5679.json');
    const file = JSON.parse(await readFile(path, 'utf8')) as FindingFile;
    await writeFile(path, JSON.stringify({ ...file, status: 'dismissed', reason: 'The header names the preset.' }));
    expect(await syncFindings(first, configFor(shared))).toEqual({ changed: ['iss_1'] });
    const workspace = new Workspace(first);
    expect(await workspace.readIssue('iss_1')).toMatchObject({
      status: 'dismissed',
      closedBy: { reason: expect.stringContaining('The header names the preset.') },
    });
    expect((await workspace.readTriage()).fingerprints.dd463fcef9ed5679).toMatchObject({ decision: 'dismissed' });

    // A third machine's judge files it again: publishing dismisses it, and files nothing.
    const third = await temp('file-machine-3');
    await workspaceWith(third);
    expect(await runPublisher(third, configFor(shared), { createRuntime: publishingRuntime })).toMatchObject([
      { kind: 'linked' },
    ]);
    expect((await new Workspace(third).readIssue('iss_1'))?.status).toBe('dismissed');
    expect(await findings(shared)).toHaveLength(1);
  });

  it('closes a fixed finding and reopens a regression, each with its evidence in the history', async () => {
    const root = await temp('file-close');
    const dir = join(root, 'findings');
    const config = configFor(dir);
    const { workspace } = await workspaceWith(root);
    await runPublisher(root, config, { createRuntime: publishingRuntime });
    const fixed: Issue = {
      ...(await workspace.readIssue('iss_1'))!,
      status: 'fixed',
      closedBy: { by: 'Bugpatrol', reason: 'A recheck on main did not find it.', at: 'now' },
    };
    await workspace.saveIssue(fixed);
    await closeFinding(root, config, fixed, { evidence: 'Recheck: the header matches the knob.' });
    let [file] = await findings(dir);
    expect(file).toMatchObject({ status: 'fixed' });
    expect(file!.history.at(-1)?.note).toContain('Recheck: the header matches the knob.');
    expect((await workspace.readIssue('iss_1'))?.published?.file?.state).toBe('fixed');

    // The judge sees it again: a regression.
    await workspace.saveIssue({
      ...(await workspace.readIssue('iss_1'))!,
      status: 'new',
      regression: { at: '2026-10-17T10:00:00Z', fromStatus: 'fixed' },
      occurrences: 2,
    });
    const runtime = publishingRuntime();
    expect(await runPublisher(root, config, { createRuntime: () => runtime })).toMatchObject([{ kind: 'reopened' }]);
    expect(runtime.ran).toBe(0);
    [file] = await findings(dir);
    expect(file).toMatchObject({ status: 'open' });
    expect(file!.history.at(-1)?.note).toContain('seen again');
    expect(await findings(dir)).toHaveLength(1);
  });
});
