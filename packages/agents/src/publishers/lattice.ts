import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { BugpatrolConfig, Issue, Severity } from '@bugpatrol/core';
import { fingerprintMarker, markerFingerprints } from '../report.js';
import type { CreateInput, Filed, Finding, FindingState, Publisher, Ready } from './index.js';
import { asFinding, refOn, setRef, syncTracker, trackerTarget } from './tracker.js';

/** One run of the lattice CLI. A failed run still returns: Lattice prints its error as JSON on stdout. */
export type LatticeRun = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Runs `bin` in `cwd`, where Lattice finds its board the way git finds a repository. */
function latticeRunner(bin: string, cwd: string): LatticeRun {
  return (args) =>
    new Promise((done) => {
      execFile(bin, args, { cwd, maxBuffer: 64 * 1024 * 1024, timeout: 120_000 }, (error, stdout, stderr) => {
        const code = !error ? 0 : typeof error.code === 'number' ? error.code : 127;
        done({ code, stdout: String(stdout), stderr: String(stderr || (error && code === 127 ? error.message : '')) });
      });
    });
}

class LatticeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Task = {
  id: string;
  short_id?: string | null;
  title: string;
  status: string;
  description?: string | null;
  last_status_changed_at?: string | null;
  events?: { type: string; data?: { reason?: string | null }; provenance?: { reason?: string | null } | null }[];
};

const PRIORITY: Record<Severity, string> = { critical: 'critical', major: 'high', minor: 'medium', cosmetic: 'low' };

/**
 * Findings as tasks on a Lattice board, through the `lattice` CLI and its
 * `--json` output. The fingerprints and the routine ride in hidden markers in
 * the description; screenshots are artifacts on the task. A fixed finding
 * moves to `fixedStatus`, a regression back to `reopenStatus`, each with a
 * comment carrying the evidence. A task a person moves to a dismissed status
 * (cancelled, won't do) is a dismissal.
 */
export class LatticePublisher implements Publisher {
  readonly name = 'lattice' as const;
  readonly label = 'Lattice';
  readonly fingerprints = true;
  private readonly settings: BugpatrolConfig['agents']['publisher']['lattice'];
  private readonly dir: string;
  private readonly target: string;
  private readonly run: LatticeRun;
  private readonly onLog?: (message: string) => void;
  /** Dismissal reasons by task id and status time: each needs a `show`. */
  private readonly reasons = new Map<string, string | undefined>();

  constructor(
    private readonly root: string,
    config: BugpatrolConfig,
    deps: { run?: LatticeRun; onLog?: (message: string) => void } = {},
  ) {
    this.settings = config.agents.publisher.lattice;
    this.dir = resolve(root, this.settings.dir);
    this.target = trackerTarget(root, this.dir);
    this.run = deps.run ?? latticeRunner(this.settings.bin, this.dir);
    this.onLog = deps.onLog;
  }

  private async call<T>(args: string[]): Promise<T> {
    const out = await this.run(args);
    let parsed: { ok?: boolean; data?: T; error?: { code?: string; message?: string } } | undefined;
    try {
      parsed = JSON.parse(out.stdout);
    } catch {
      /* Not JSON: the CLI failed before it could answer. */
    }
    if (parsed?.ok) return parsed.data as T;
    const detail = parsed?.error?.message ?? (out.stderr.trim() || out.stdout.trim() || `exit ${out.code}`);
    throw new LatticeError(parsed?.error?.code ?? 'FAILED', `${this.settings.bin} ${args[0]}: ${detail}`);
  }

  private actor(): string[] {
    return ['--actor', this.settings.actor];
  }

  async ready(): Promise<Ready> {
    const out = await this.run(['--version']);
    if (out.code === 0) return { ok: true };
    return {
      ok: false,
      reason:
        `Publish skipped: ${this.settings.bin} did not run in ${this.dir} (${out.stderr.trim() || `exit ${out.code}`}). ` +
        'Install Lattice, or set agents.publisher.lattice.bin.',
    };
  }

  private state(status: string): FindingState {
    if (this.settings.dismissedStatuses.includes(status)) return 'dismissed';
    return status === this.settings.fixedStatus ? 'fixed' : 'open';
  }

  /** The reason on the task's last status move, which is where a person says why they dismissed it. */
  private async reason(task: Task): Promise<string | undefined> {
    const key = `${task.id}@${task.last_status_changed_at ?? ''}`;
    if (!this.reasons.has(key)) {
      try {
        const shown = await this.call<Task>(['show', task.id, '--json']);
        const moves = (shown.events ?? []).filter((event) => event.type === 'status_changed');
        const last = moves.at(-1);
        this.reasons.set(key, last?.provenance?.reason ?? last?.data?.reason ?? undefined);
      } catch {
        this.reasons.set(key, undefined);
      }
    }
    return this.reasons.get(key);
  }

  private finding(task: Task): Finding {
    return {
      id: task.id,
      name: task.short_id || task.id,
      title: task.title,
      url: task.short_id || task.id,
      state: this.state(task.status),
      stateAt: task.last_status_changed_at ?? undefined,
      fingerprints: markerFingerprints(task.description ?? ''),
    };
  }

  async filed(): Promise<Filed> {
    const tasks = await this.call<Task[]>(['list', '--tag', this.settings.tag, '--include-archived', '--json']);
    const findings: Finding[] = [];
    for (const task of tasks) {
      const finding = this.finding(task);
      if (finding.state === 'dismissed') finding.reason = await this.reason(task);
      findings.push(finding);
    }
    return {
      findings: findings.filter((finding) => finding.fingerprints?.length),
      lines: findings.map((finding) => `- ${finding.name} [${finding.state}]: ${finding.title}`),
    };
  }

  ref(issue: Issue): Finding | undefined {
    const ref = refOn(issue, this.name, this.target);
    return ref && asFinding(issue, ref);
  }

  link(issue: Issue, finding: Finding): void {
    setRef(issue, this.name, this.target, finding);
  }

  /** Lattice attaches after the task exists: each screenshot is named by its session and file. */
  async images(_issueId: string, paths: string[]): Promise<Map<string, string>> {
    return new Map(paths.map((path) => [path, path.split(/[\\/]/).slice(-2).join('/')]));
  }

  readonly renderImage = (name: string) => `Attached to this task as ${name}.`;

  async create(input: CreateInput): Promise<Finding> {
    const task = await this.call<Task>([
      'create',
      '--type',
      this.settings.type,
      '--priority',
      PRIORITY[input.issue.severity],
      '--tag',
      this.settings.tag,
      '--description',
      `${fingerprintMarker(input.fingerprints)}\n${input.body}`,
      ...this.actor(),
      '--json',
      '--',
      input.title,
    ]);
    for (const [path, title] of input.images) {
      try {
        await this.call([
          'attach',
          task.id,
          resolve(this.root, path),
          '--type',
          'file',
          '--title',
          title,
          ...this.actor(),
          '--json',
        ]);
      } catch (error) {
        // The task exists, so the bug is filed: report the missing screenshot and go on.
        this.onLog?.(`Lattice did not attach ${path} to ${task.short_id ?? task.id}: ${String(error)}`);
      }
    }
    return this.finding(task);
  }

  private async comment(id: string, text: string): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'bugpatrol-lattice-'));
    try {
      const file = join(dir, 'comment.md');
      await writeFile(file, text);
      await this.call(['comment', id, '--file', file, ...this.actor(), '--json']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** A task a person dismissed stays dismissed: the next sync dismisses the issue instead. */
  private async guard(id: string, status: string): Promise<void> {
    const current = (await this.call<Task>(['show', id, '--json'])).status;
    if (this.state(current) === 'dismissed' && this.state(status) !== 'dismissed')
      throw new Error(`${id} is ${current} on Lattice, set by a person; Bugpatrol leaves it there.`);
  }

  /** Bugpatrol's moves skip the workflow's middle steps, so a refused transition is forced, with its reason. */
  private async move(id: string, status: string, reason: string): Promise<void> {
    const args = ['status', id, status, '--reason', reason, ...this.actor(), '--json'];
    try {
      await this.call(args);
    } catch (error) {
      if ((error as LatticeError).code !== 'INVALID_TRANSITION') throw error;
      await this.call([...args, '--force']);
    }
  }

  async close(issue: Issue, input: { as: 'fixed' | 'dismissed'; evidence: string }): Promise<void> {
    const ref = refOn(issue, this.name, this.target);
    if (!ref) return;
    const status = input.as === 'dismissed' ? this.settings.dismissedStatuses[0]! : this.settings.fixedStatus;
    await this.guard(ref.id, status);
    await this.comment(ref.id, input.evidence);
    await this.move(ref.id, status, `Bugpatrol: ${input.as === 'dismissed' ? 'not a bug' : 'fixed'}, see the comment`);
    ref.state = input.as;
    ref.stateAt = new Date().toISOString();
  }

  async reopen(issue: Issue, evidence: string): Promise<void> {
    const ref = refOn(issue, this.name, this.target);
    if (!ref) return;
    await this.guard(ref.id, this.settings.reopenStatus);
    await this.comment(ref.id, evidence);
    await this.move(ref.id, this.settings.reopenStatus, 'Bugpatrol: seen again after it was fixed, see the comment');
    ref.state = 'open';
    ref.stateAt = new Date().toISOString();
  }

  sync(onLog?: (message: string) => void): Promise<{ changed: string[] }> {
    return syncTracker(this.root, this, this.name, this.target, onLog ?? this.onLog);
  }
}
