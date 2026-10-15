import { type ChildProcess, spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { type AppCommand, type AppConfig, InfrastructureError, paths } from '@bugpatrol/core';
import type { Vars } from './vars.js';

type Options = { root: string; vars: Vars; emit?: (summary: string) => void; source?: string };

/** Shell commands belong to the app configuration. A source override swaps commands rooted at app.source into the worktree; every command receives BUGPATROL_SOURCE (and BUGHUNTERS_SOURCE, its name before the rename). Output is redacted. */
export async function startApp(app: AppConfig, opts: Options): Promise<{ vars: Vars; stop(): Promise<void> }> {
  const children: ChildProcess[] = [];
  const report = (message: string) => opts.emit?.(opts.vars.redact(message) as string);
  const configuredSource = resolve(opts.root, app.source);
  const effectiveSource = opts.source ?? configuredSource;
  // A fixer's worktree is left alone: the line would land in its diff.
  if (app.connect.handset && !opts.source) {
    // Handset's project is the folder `handset run` runs in, so the file goes there.
    const runsHandset = app.setup.filter((command) => /\bhandset\b/.test(command.run));
    const folders = new Set(
      runsHandset.length
        ? runsHandset.map((command) => resolve(opts.root, opts.vars.resolveConfig(command.cwd ?? '.')))
        : [configuredSource],
    );
    for (const folder of folders) {
      const added = ignoreForHandset(opts.root, folder);
      if (added)
        report(`Added ${added} to ${join(folder, '.handsetignore')}: Bugpatrol's files are not app source. Commit it.`);
    }
  }

  async function run(command: AppCommand, phase: 'Setup' | 'Teardown'): Promise<void> {
    const shell = opts.vars.resolveConfig(command.run);
    const configuredCwd = resolve(opts.root, opts.vars.resolveConfig(command.cwd ?? '.'));
    const cwd = opts.source && configuredCwd === configuredSource ? opts.source : configuredCwd;
    const env = {
      ...process.env,
      ...Object.fromEntries(opts.vars.entries()),
      BUGPATROL_SOURCE: effectiveSource,
      BUGHUNTERS_SOURCE: effectiveSource,
    };
    const started = Date.now();
    const child = spawn('/bin/sh', ['-c', shell], {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let settled = false;
    const captures = Object.entries(command.capture).map(([name, pattern]) => [name, new RegExp(pattern)] as const);
    const append = (chunk: Buffer) => {
      output += chunk.toString();
      for (const [name, pattern] of captures) {
        const match = pattern.exec(output);
        if (match?.[1] !== undefined) {
          opts.vars.set(name, match[1]);
        }
      }
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const exit = new Promise<number>((done, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => {
        settled = true;
        done(code ?? 1);
      });
    });
    const timeout = setTimeout(() => killGroup(child), command.timeoutMs);
    try {
      if (command.background) {
        if (command.readyWhen) {
          const ready = new RegExp(command.readyWhen);
          await new Promise<void>((done, reject) => {
            const wait = setTimeout(() => finish(new Error('timed out waiting for ready output')), command.timeoutMs);
            const finish = (error?: Error) => {
              clearTimeout(wait);
              child.stdout?.off('data', check);
              child.stderr?.off('data', check);
              child.off('exit', onExit);
              child.off('error', finish);
              if (error) {
                reject(error);
              } else {
                done();
              }
            };
            const check = () => {
              if (ready.test(output)) {
                finish();
              }
            };
            const onExit = () => finish(new Error('exited before ready'));
            child.stdout?.on('data', check);
            child.stderr?.on('data', check);
            child.once('exit', onExit);
            child.once('error', finish);
            check();
          });
        }
        children.push(child);
        void exit.catch(() => undefined);
      } else {
        const code = await exit;
        if (code !== 0) {
          throw new Error(`exit ${code}`);
        }
      }
      report(`${phase}: ran \`${shell}\` (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    } catch (cause) {
      if (!settled) {
        killGroup(child);
      }
      const tail = output.trim().split('\n').slice(-20).join('\n');
      const message = `${phase} command \`${opts.vars.redact(shell)}\` failed: ${String(cause)}`;
      throw new InfrastructureError(`${message}\n${opts.vars.redact(tail)}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  try {
    for (const command of app.setup) {
      await run(command, 'Setup');
    }
  } catch (error) {
    // A setup that fails halfway may already hold resources (a test run, an
    // identity). Teardown undoes what it can before the error goes up.
    for (const command of app.teardown) {
      try {
        await run(command, 'Teardown');
      } catch (cause) {
        report(String(cause));
      }
    }
    for (const child of children) {
      killGroup(child);
    }
    throw error;
  }
  return {
    vars: opts.vars,
    async stop() {
      for (const command of app.teardown) {
        try {
          await run(command, 'Teardown');
        } catch (error) {
          report(String(error));
        }
      }
      await Promise.all(
        children.map(async (child) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            return;
          }
          killGroup(child);
          const timer = setTimeout(() => killGroup(child, 'SIGKILL'), 5_000);
          await new Promise<void>((done) => child.once('exit', () => done()));
          clearTimeout(timer);
        }),
      );
    },
  };
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (!child.pid) {
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

/**
 * Bugpatrol writes into its own folder every session: run data, and also the
 * app map and the routines, which are committed. Handset fingerprints the
 * app's source, tracked files included, to decide whether to rebuild, so
 * each session forced a rebuild. Handset's own `.handsetignore`, at the root
 * of its project, says what is not source. Adds the folder to it once, when
 * the folder is inside that project, and returns the line it added.
 */
function ignoreForHandset(root: string, source: string): string | undefined {
  const folder = relative(source, paths.dir(root));
  if (!folder || folder === '..' || folder.startsWith(`..${sep}`) || isAbsolute(folder)) return undefined;
  const line = `${folder.split('\\').join('/')}/`;
  const file = join(source, '.handsetignore');
  try {
    const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const bare = line.slice(0, -1);
    if (current.split('\n').some((each) => [line, bare, `/${line}`, `/${bare}`].includes(each.trim())))
      return undefined;
    const separator = current && !current.endsWith('\n') ? '\n' : '';
    appendFileSync(
      file,
      `${separator}# Bugpatrol's own files (config, app map, routines, run data) are not app source.\n${line}\n`,
    );
    return line;
  } catch {
    // Best effort: a read-only checkout only costs a rebuild.
    return undefined;
  }
}
