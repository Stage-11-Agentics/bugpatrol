import { createHash } from 'node:crypto';
import { link, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import type { BugpatrolConfig, Issue, Severity } from '@bugpatrol/core';
import { fingerprintMarker } from '../report.js';
import type { CreateInput, Filed, Finding, FindingState, Publisher, Ready } from './index.js';
import { asFinding, refOn, setRef, syncTracker, trackerTarget } from './tracker.js';

/**
 * One finding on disk. A person dismisses it by setting `status` to
 * `dismissed` (and `reason` to why); the next sync dismisses the issue, and the
 * judge does not file it again. Bugpatrol never writes over a dismissal.
 */
export type FindingFile = {
  version: 1;
  /** The file name without `.json`: the first fingerprint. */
  id: string;
  title: string;
  severity: Severity;
  /** open, fixed or dismissed. */
  status: FindingState;
  /** Why it was closed or dismissed. */
  reason?: string;
  /** The issue's fingerprint first, then its candidates'. A machine that sees any of them links to this finding. */
  fingerprints: string[];
  /** The issue that filed it, on the machine that filed it. */
  issueId: string;
  screenId?: string;
  /** The committed routine that replays it. */
  routine?: string;
  /** The report, with its hidden markers. */
  body: string;
  /** Relative to the findings directory. */
  screenshots: string[];
  createdAt: string;
  updatedAt: string;
  /** Each close and reopen, with its evidence. */
  history: { at: string; status: FindingState; by: string; note: string }[];
};

const STATES: FindingState[] = ['open', 'fixed', 'dismissed'];
const safe = (value: string) => value.replace(/[^\w.-]/g, '_');
const json = (file: FindingFile) => `${JSON.stringify(file, null, 2)}\n`;
const statusOf = (file: FindingFile) =>
  String(file.status ?? '')
    .trim()
    .toLowerCase();

/** Findings as JSON files in a directory: dedupe and dismissal with no service at all. */
export class FilePublisher implements Publisher {
  readonly name = 'file' as const;
  readonly label = 'the findings directory';
  readonly fingerprints = true;
  private readonly dir: string;
  private readonly target: string;
  private readonly onLog?: (message: string) => void;

  constructor(
    private readonly root: string,
    config: BugpatrolConfig,
    deps: { onLog?: (message: string) => void } = {},
  ) {
    this.dir = resolve(root, config.agents.publisher.file.dir);
    this.target = trackerTarget(root, this.dir);
    this.onLog = deps.onLog;
  }

  async ready(): Promise<Ready> {
    try {
      await mkdir(this.dir, { recursive: true });
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: `Publish skipped: cannot create ${this.dir}: ${String(error)}` };
    }
  }

  private path(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  /** The finding's file. Throws, naming the file, when it is missing or not a finding. */
  private async read(id: string): Promise<FindingFile> {
    const path = this.path(id);
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`The finding ${path} is gone.`);
      throw error;
    }
    let file: FindingFile;
    try {
      file = JSON.parse(text) as FindingFile;
    } catch (error) {
      throw new Error(`The finding ${path} is not valid JSON: ${String(error)}`);
    }
    if (!Array.isArray(file?.fingerprints)) throw new Error(`The finding ${path} has no fingerprints list.`);
    // The name on disk is the id, whatever the file says.
    return { ...file, id };
  }

  /** Write through a temporary file, so a reader never sees half a finding. */
  private async write(file: FindingFile): Promise<void> {
    const temp = join(this.dir, `.${file.id}.${process.pid}.tmp`);
    await writeFile(temp, json(file));
    await rename(temp, this.path(file.id));
  }

  private async finding(file: FindingFile): Promise<Finding> {
    const status = statusOf(file) as FindingState;
    const known = STATES.includes(status);
    if (!known)
      this.onLog?.(
        `${this.path(file.id)}: status "${file.status}" is not open, fixed or dismissed; the sync leaves it.`,
      );
    // A person who edits the status by hand does not touch updatedAt; the file's own time says when.
    const changed = await stat(this.path(file.id)).then(
      (info) => info.mtime.toISOString(),
      () => file.updatedAt,
    );
    return {
      id: file.id,
      name: `${file.id}.json`,
      title: file.title,
      url: this.path(file.id),
      state: known ? status : 'open',
      stateAt: changed,
      fingerprints: file.fingerprints,
      reason: file.reason,
      ...(known ? {} : { unknownState: true }),
    };
  }

  async filed(): Promise<Filed> {
    let names: string[] = [];
    try {
      names = (await readdir(this.dir)).filter((name) => name.endsWith('.json') && !name.startsWith('.'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const findings: Finding[] = [];
    for (const name of names.sort()) {
      try {
        findings.push(await this.finding(await this.read(name.slice(0, -'.json'.length))));
      } catch (error) {
        this.onLog?.(`Skipped a finding that cannot be read: ${(error as Error).message}`);
      }
    }
    return {
      findings,
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

  async images(issueId: string, paths: string[]): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    const dir = join(this.dir, 'images', safe(issueId));
    for (const path of paths) {
      try {
        const bytes = await readFile(resolve(this.root, path));
        const target = join(dir, `${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}-${basename(path)}`);
        await mkdir(dir, { recursive: true });
        await writeFile(target, bytes);
        names.set(path, relative(this.dir, target));
      } catch (error) {
        // A missing screenshot never keeps a bug from being filed.
        this.onLog?.(`Left out a screenshot of ${issueId}: ${String(error)}`);
      }
    }
    return names;
  }

  async create(input: CreateInput): Promise<Finding> {
    const id = safe(input.fingerprints[0] ?? input.issue.fingerprint);
    const now = new Date().toISOString();
    const file: FindingFile = {
      version: 1,
      id,
      title: input.title,
      severity: input.issue.severity,
      status: 'open',
      fingerprints: input.fingerprints,
      issueId: input.issue.id,
      ...(input.issue.screenId ? { screenId: input.issue.screenId } : {}),
      ...(input.issue.evidence.reproRoutineId ? { routine: input.issue.evidence.reproRoutineId } : {}),
      body: `${fingerprintMarker(input.fingerprints)}\n${input.body}`,
      screenshots: [...new Set(input.images.values())],
      createdAt: now,
      updatedAt: now,
      history: [{ at: now, status: 'open', by: 'Bugpatrol', note: 'Filed.' }],
    };
    await mkdir(this.dir, { recursive: true });
    // A whole file, then an exclusive link: another machine that filed the
    // same fingerprint first keeps its finding, and no reader sees half of one.
    const temp = join(this.dir, `.${id}.${process.pid}.new`);
    await writeFile(temp, json(file));
    try {
      await link(temp, this.path(id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      return this.finding(await this.read(id));
    } finally {
      await unlink(temp).catch(() => {});
    }
    return this.finding(file);
  }

  private async move(issue: Issue, status: FindingState, note: string): Promise<void> {
    const ref = refOn(issue, this.name, this.target);
    if (!ref) return;
    const file = await this.read(ref.id);
    // A person's dismissal is the last word: the next sync dismisses the issue instead.
    if (statusOf(file) === 'dismissed' && status !== 'dismissed')
      throw new Error(`${this.path(ref.id)} was dismissed by a person; Bugpatrol leaves it dismissed.`);
    const at = new Date().toISOString();
    file.status = status;
    if (status === 'open') delete file.reason;
    else file.reason = note.split('\n')[0];
    file.updatedAt = at;
    file.history = [...(file.history ?? []), { at, status, by: 'Bugpatrol', note }];
    await this.write(file);
    ref.state = status;
    ref.stateAt = at;
  }

  close(issue: Issue, input: { as: 'fixed' | 'dismissed'; evidence: string }): Promise<void> {
    return this.move(issue, input.as, input.evidence);
  }

  reopen(issue: Issue, evidence: string): Promise<void> {
    return this.move(issue, 'open', evidence);
  }

  sync(onLog?: (message: string) => void): Promise<{ changed: string[] }> {
    return syncTracker(this.root, this, this.name, this.target, onLog ?? this.onLog);
  }
}
