import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import type { BugpatrolConfig, Issue, Severity } from '@bugpatrol/core';
import { fingerprintMarker } from '../report.js';
import type { CreateInput, Filed, Finding, FindingState, Publisher, Ready } from './index.js';
import { asFinding, refOn, setRef, syncTracker } from './tracker.js';

/**
 * One finding on disk. A person dismisses it by setting `status` to
 * `dismissed` (and `reason` to why); the next sync dismisses the issue, and the
 * judge does not file it again.
 */
export type FindingFile = {
  version: 1;
  /** The file name without `.json`: the first fingerprint. */
  id: string;
  title: string;
  severity: Severity;
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

/** Findings as JSON files in a directory: dedupe and dismissal with no service at all. */
export class FilePublisher implements Publisher {
  readonly name = 'file' as const;
  readonly label = 'the findings directory';
  readonly fingerprints = true;
  private readonly dir: string;

  constructor(
    private readonly root: string,
    config: BugpatrolConfig,
  ) {
    this.dir = resolve(root, config.agents.publisher.file.dir);
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

  private async read(id: string): Promise<FindingFile | undefined> {
    try {
      return JSON.parse(await readFile(this.path(id), 'utf8')) as FindingFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  /** Write through a temporary file, so a reader never sees half a finding. */
  private async write(file: FindingFile): Promise<void> {
    const temp = join(this.dir, `.${file.id}.${process.pid}.tmp`);
    await writeFile(temp, `${JSON.stringify(file, null, 2)}\n`);
    await rename(temp, this.path(file.id));
  }

  private finding(file: FindingFile): Finding {
    const state = STATES.includes(file.status) ? file.status : 'open';
    return {
      id: file.id,
      name: `${file.id}.json`,
      title: file.title,
      url: this.path(file.id),
      state,
      stateAt: file.updatedAt,
      fingerprints: file.fingerprints,
      reason: file.reason,
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
      const file = await this.read(name.slice(0, -'.json'.length)).catch(() => undefined);
      if (file?.id && Array.isArray(file.fingerprints)) findings.push(this.finding(file));
    }
    return {
      findings,
      lines: findings.map((finding) => `- ${finding.name} [${finding.state}]: ${finding.title}`),
    };
  }

  ref(issue: Issue): Finding | undefined {
    const ref = refOn(issue, this.name, this.dir);
    return ref && asFinding(issue, ref);
  }

  link(issue: Issue, finding: Finding): void {
    setRef(issue, this.name, this.dir, finding);
  }

  async images(issueId: string, paths: string[]): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    const dir = join(this.dir, 'images', safe(issueId));
    if (paths.length) await mkdir(dir, { recursive: true });
    for (const path of paths) {
      const source = resolve(this.root, path);
      const bytes = await readFile(source);
      const target = join(dir, `${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}-${basename(path)}`);
      await copyFile(source, target);
      names.set(path, relative(this.dir, target));
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
    try {
      // wx: another machine that filed the same fingerprint first keeps its finding.
      await writeFile(this.path(id), `${JSON.stringify(file, null, 2)}\n`, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await this.read(id);
      if (existing) return this.finding(existing);
      throw error;
    }
    return this.finding(file);
  }

  private async move(issue: Issue, status: FindingState, note: string, reason?: string): Promise<void> {
    const ref = refOn(issue, this.name, this.dir);
    const file = ref && (await this.read(ref.id));
    if (!ref || !file) return;
    const at = new Date().toISOString();
    file.status = status;
    if (reason) file.reason = reason;
    else delete file.reason;
    file.updatedAt = at;
    file.history.push({ at, status, by: 'Bugpatrol', note });
    await this.write(file);
    ref.state = status;
    ref.stateAt = at;
  }

  close(issue: Issue, input: { as: 'fixed' | 'dismissed'; evidence: string }): Promise<void> {
    return this.move(issue, input.as, input.evidence, input.evidence);
  }

  reopen(issue: Issue, evidence: string): Promise<void> {
    return this.move(issue, 'open', evidence);
  }

  sync(): Promise<{ changed: string[] }> {
    return syncTracker(this.root, this, this.name, this.dir);
  }
}
