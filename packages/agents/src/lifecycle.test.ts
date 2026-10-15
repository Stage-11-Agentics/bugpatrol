import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appSchema, InfrastructureError } from '@bugpatrol/core';
import { describe, expect, it } from 'vitest';
import { startApp } from './lifecycle.js';
import { Vars } from './vars.js';

describe('startApp', () => {
  it("tells Handset, before setup runs, that Bugpatrol's folder is not app source", async () => {
    const root = await mkdtemp(join(tmpdir(), 'bugpatrol-life-'));
    try {
      await mkdir(join(root, '.bugpatrol'));
      await writeFile(join(root, '.bugpatrol', 'bugpatrol.yml'), 'version: 1\n');
      await writeFile(join(root, '.handsetignore'), 'fixtures/');
      const app = appSchema.parse({
        connect: { handset: { lease: '${LEASE}' } },
        // `handset run` in setup must already see the line.
        setup: [{ run: 'grep -qx ".bugpatrol/" .handsetignore' }],
      });
      await (await startApp(app, { root, vars: new Vars() })).stop();
      await (await startApp(app, { root, vars: new Vars() })).stop();
      expect(await readFile(join(root, '.handsetignore'), 'utf8')).toBe(
        "fixtures/\n# Bugpatrol's own files (config, app map, routines, run data) are not app source.\n.bugpatrol/\n",
      );
      // A fixer's worktree must not gain a file in its diff, and an app not driven through Handset needs none.
      const worktree = await mkdtemp(join(tmpdir(), 'bugpatrol-life-wt-'));
      const leased = appSchema.parse({ connect: { handset: { lease: '${LEASE}' } } });
      await (await startApp(leased, { root, vars: new Vars(), source: worktree })).stop();
      await expect(readFile(join(worktree, '.handsetignore'), 'utf8')).rejects.toThrow();
      await rm(worktree, { recursive: true, force: true });
      const plain = await mkdtemp(join(tmpdir(), 'bugpatrol-life-plain-'));
      await (await startApp(appSchema.parse({}), { root: plain, vars: new Vars() })).stop();
      await expect(readFile(join(plain, '.handsetignore'), 'utf8')).rejects.toThrow();
      await rm(plain, { recursive: true, force: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('captures values for later commands and keeps a ready background process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bugpatrol-life-'));
    const vars = new Vars();
    const emitted: string[] = [];
    try {
      const app = appSchema.parse({
        setup: [
          { run: 'echo "CDP :9624"', capture: { CDP_PORT: 'CDP :(\\d+)' } },
          { run: 'test "${CDP_PORT}" = 9624' },
          { run: 'echo READY; sleep 20', background: true, readyWhen: 'READY', timeoutMs: 1000 },
        ],
        teardown: [{ run: 'echo goodbye' }, { run: 'exit 2' }],
      });
      const running = await startApp(app, { root, vars, emit: (line) => emitted.push(line) });
      expect(vars.resolve('{{CDP_PORT}}')).toBe('9624');
      await expect(running.stop()).resolves.toBeUndefined();
      expect(emitted.some((line) => line.includes('Teardown: ran'))).toBe(true);
      expect(emitted.some((line) => line.includes('failed'))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('redacts failure output', async () => {
    const vars = new Vars();
    vars.set('TOKEN', 'secret-value');
    const app = appSchema.parse({ setup: [{ run: 'echo secret-value; exit 3' }] });
    await expect(startApp(app, { root: process.cwd(), vars })).rejects.toBeInstanceOf(InfrastructureError);
    await expect(startApp(app, { root: process.cwd(), vars })).rejects.toThrow('{{TOKEN}}');
  });

  it('runs the teardown when a setup command fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bugpatrol-teardown-'));
    try {
      const app = appSchema.parse({
        setup: [{ run: 'echo up > state' }, { run: 'exit 2' }],
        teardown: [{ run: 'echo down > state' }],
      });
      await expect(startApp(app, { root, vars: new Vars() })).rejects.toBeInstanceOf(InfrastructureError);
      expect((await readFile(join(root, 'state'), 'utf8')).trim()).toBe('down');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('swaps only source commands into the worktree and sets BUGPATROL_SOURCE for every command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bugpatrol-source-'));
    const source = join(root, 'source');
    const worktree = join(root, 'fix');
    const other = join(root, 'other');
    const { mkdir } = await import('node:fs/promises');
    try {
      await Promise.all([mkdir(source), mkdir(worktree), mkdir(other)]);
      const app = appSchema.parse({
        source: 'source',
        setup: [
          { run: 'pwd > source-cwd; echo "$BUGPATROL_SOURCE" > source-env', cwd: './source' },
          { run: 'pwd > other-cwd; echo "$BUGPATROL_SOURCE" > other-env', cwd: 'other' },
        ],
      });
      await (await startApp(app, { root, vars: new Vars(), source: worktree })).stop();
      expect((await readFile(join(worktree, 'source-cwd'), 'utf8')).trim()).toBe(await realpath(worktree));
      expect((await readFile(join(other, 'other-cwd'), 'utf8')).trim()).toBe(await realpath(other));
      expect((await readFile(join(other, 'other-env'), 'utf8')).trim()).toBe(worktree);
      await (await startApp(app, { root, vars: new Vars() })).stop();
      expect((await readFile(join(source, 'source-env'), 'utf8')).trim()).toBe(source);
      expect((await readFile(join(other, 'other-env'), 'utf8')).trim()).toBe(source);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
