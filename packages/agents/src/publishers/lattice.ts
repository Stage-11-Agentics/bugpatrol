import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { BugpatrolConfig, Issue, Severity } from '@bugpatrol/core';
import { fingerprintMarker, markerFingerprints } from '../report.js';
import type { CreateInput, Filed, Finding, FindingState, Publisher, Ready } from './index.js';
import { asFinding, refOn, setRef, syncTracker, trackerTarget } from './tracker.js';

/** One run of the lattice CLI. A failed run still returns: Lattice prints its error as JSON on stdout. */
export type LatticeRun = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

/**
 * Runs `bin` on the board at `board`. LATTICE_ROOT pins the CLI to that board:
 * with no board there it fails, rather than walk up to a parent's board.
 */
function latticeRunner(bin: string, cwd: string, board: string): LatticeRun {
  return (args) =>
    new Promise((done) => {
      execFile(
        bin,
        args,
        { cwd, env: { ...process.env, LATTICE_ROOT: board }, maxBuffer: 64 * 1024 * 1024, timeout: 120_000 },
        (error, stdout, stderr) => {
          const code = !error ? 0 : typeof error.code === 'number' ? error.code : 127;
          done({
            code,
            stdout: String(stdout),
            stderr: String(stderr || (error && code === 127 ? error.message : '')),
          });
        },
      );
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
  archived?: boolean;
  last_status_changed_at?: string | null;
  events?: { type: string; data?: { reason?: string | null }; provenance?: { reason?: string | null } | null }[];
};

const PRIORITY: Record<Severity, string> = { critical: 'critical', major: 'high', minor: 'medium', cosmetic: 'low' };
const firstLine = (text: string) => (text.split('\n').find((line) => line.trim()) ?? '').trim().slice(0, 200);

/**
 * Findings as tasks on a Lattice board, through the `lattice` CLI and its
 * `--json` output. The fingerprints and the routine ride in hidden markers in
 * the description; screenshots are artifacts on the task. A fixed finding
 * moves to `fixedStatus`, a regression back to `reopenStatus`, each with a
 * comment carrying the evidence. A task a person moves to a dismissed status
 * (cancelled, won't do) is a dismissal, and Bugpatrol never moves it again.
 */
export class LatticePublisher implements Publisher {
  readonly name = 'lattice' as const;
  readonly label = 'Lattice';
  readonly fingerprints = true;
  private readonly settings: BugpatrolConfig['agents']['publisher']['lattice'];
  private readonly board: string;
  private readonly target: string;
  private readonly run: LatticeRun;
  private readonly onLog?: (message: string) => void;

  constructor(
    private readonly root: string,
    config: BugpatrolConfig,
    deps: { run?: LatticeRun; onLog?: (message: string) => void } = {},
  ) {
    this.settings = config.agents.publisher.lattice;
    this.board = resolve(root, this.settings.dir);
    this.target = trackerTarget(root, this.board);
    this.run = deps.run ?? latticeRunner(this.settings.bin, root, this.board);
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

  private list(): Promise<Task[]> {
    return this.call<Task[]>(['list', '--tag', this.settings.tag, '--include-archived', '--json']);
  }

  async ready(): Promise<Ready> {
    const fix = 'Run `lattice init` there, or set agents.publisher.lattice.dir and bin.';
    if (!existsSync(this.board))
      return { ok: false, reason: `Publish skipped: no Lattice board at ${this.board}. ${fix}` };
    try {
      await this.list();
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: `Publish skipped: ${(error as Error).message}. ${fix}` };
    }
  }

  private state(status: string): FindingState {
    if (this.settings.dismissedStatuses.includes(status)) return 'dismissed';
    return status === this.settings.fixedStatus ? 'fixed' : 'open';
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

  /** Every task with the tag, also one whose marker a person edited away: the sync still follows it by id. */
  async filed(): Promise<Filed> {
    const findings = (await this.list()).map((task) => this.finding(task));
    return { findings, lines: findings.map((finding) => `- ${finding.name} [${finding.state}]: ${finding.title}`) };
  }

  /** The reason on the task's last status move, where a person says why they dismissed it. */
  async reasonFor(finding: Finding): Promise<string | undefined> {
    try {
      const shown = await this.call<Task>(['show', finding.id, '--json']);
      const last = (shown.events ?? []).filter((event) => event.type === 'status_changed').at(-1);
      return last?.provenance?.reason ?? last?.data?.reason ?? undefined;
    } catch {
      return undefined;
    }
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
    let task: Task;
    try {
      task = await this.call<Task>([
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
    } catch (error) {
      // The task may exist although its answer was lost (a timeout, a line that is not JSON). Look before
      // anyone files it again.
      const made = (await this.list().catch(() => [])).find((existing) =>
        markerFingerprints(existing.description ?? '').includes(input.fingerprints[0] ?? input.issue.fingerprint),
      );
      if (!made) throw error;
      this.onLog?.(`Lattice created ${made.short_id ?? made.id}, but its answer was lost: ${String(error)}`);
      task = made;
    }
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

  /**
   * A task a person dismissed stays dismissed: the next sync dismisses the
   * issue instead. An archived task comes back from the archive first, since
   * Lattice moves and comments only on active tasks.
   */
  private async prepare(id: string, status: string): Promise<void> {
    const current = await this.call<Task>(['show', id, '--json']);
    if (this.state(current.status) === 'dismissed' && this.state(status) !== 'dismissed')
      throw new Error(
        `${current.short_id ?? id} is ${current.status} on Lattice, set by a person; Bugpatrol leaves it there.`,
      );
    if (current.archived) await this.call(['unarchive', id, ...this.actor(), '--json']);
  }

  /**
   * Bugpatrol's moves skip the workflow's middle steps, so a refused
   * transition is forced, with its reason. The move comes before the comment,
   * so a failed move never leaves a comment that a retry repeats.
   */
  private async move(id: string, status: string, reason: string, evidence: string): Promise<void> {
    await this.prepare(id, status);
    const args = ['status', id, status, '--reason', reason, ...this.actor(), '--json'];
    try {
      await this.call(args);
    } catch (error) {
      if ((error as LatticeError).code !== 'INVALID_TRANSITION') throw error;
      await this.call([...args, '--force']);
    }
    await this.comment(id, evidence);
  }

  async close(issue: Issue, input: { as: 'fixed' | 'dismissed'; evidence: string }): Promise<void> {
    const ref = refOn(issue, this.name, this.target);
    if (!ref) return;
    const status = input.as === 'dismissed' ? this.settings.dismissedStatuses[0]! : this.settings.fixedStatus;
    const verdict = input.as === 'dismissed' ? 'not a bug' : 'fixed';
    await this.move(ref.id, status, `Bugpatrol: ${verdict}. ${firstLine(input.evidence)}`, input.evidence);
    ref.state = input.as;
    ref.stateAt = new Date().toISOString();
  }

  async reopen(issue: Issue, evidence: string): Promise<void> {
    const ref = refOn(issue, this.name, this.target);
    if (!ref) return;
    await this.move(ref.id, this.settings.reopenStatus, `Bugpatrol: seen again. ${firstLine(evidence)}`, evidence);
    ref.state = 'open';
    ref.stateAt = new Date().toISOString();
  }

  sync(onLog?: (message: string) => void): Promise<{ changed: string[] }> {
    return syncTracker(this.root, this, this.name, this.target, onLog ?? this.onLog);
  }
}
