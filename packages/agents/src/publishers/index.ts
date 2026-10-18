import { type BugpatrolConfig, type FixProposal, type Issue, type PublisherName, publisherOf } from '@bugpatrol/core';
import { type Gh, ghFor } from '../github.js';
import { Workspace } from '../workspace.js';
import { FilePublisher } from './file.js';
import { GitHubPublisher } from './github.js';
import { LatticePublisher, type LatticeRun } from './lattice.js';

/** What became of a finding on its tracker. Every state that is not closed counts as open. */
export type FindingState = 'open' | 'fixed' | 'dismissed';

/** One filed finding: a GitHub issue, a file, a Lattice task. */
export type Finding = {
  /** The publisher's own id: an issue number, a file name, a task id. */
  id: string;
  /** How a person names it: #8, BUG-3. */
  name: string;
  title: string;
  /** Where a person opens it. */
  url: string;
  state: FindingState;
  /** When it entered its state, when the publisher knows. */
  stateAt?: string;
  /** Read back from the finding's hidden marker. Without them, nothing matches it to an issue. */
  fingerprints?: string[];
  /** Why it was closed or dismissed, when the tracker says. */
  reason?: string;
  /** The tracker's status is not one Bugpatrol knows, such as a typo: the sync leaves the issue as it is. */
  unknownState?: boolean;
};

export type Filed = {
  /** The findings that carry fingerprints, so an issue finds its finding with no model. */
  findings: Finding[];
  /** What is already filed, one line each, for the publish judge. */
  lines: string[];
};

export type Ready = { ok: true } | { ok: false; reason: string };

export type CreateInput = {
  issue: Issue;
  title: string;
  /** The report, with each image named as `images` gave it. */
  body: string;
  /** The issue's fingerprint and its candidates', for the hidden marker. */
  fingerprints: string[];
  /** Each screenshot's workspace path, and the name `images` gave it. */
  images: Map<string, string>;
};

/**
 * Where findings go. The publish step, the sync, and the close and reopen
 * paths call only this, so a new tracker is a new Publisher, the way a new
 * platform is a new Driver.
 */
export interface Publisher {
  readonly name: PublisherName;
  /** For log lines and the publish judge: GitHub, Lattice. */
  readonly label: string;
  /**
   * Its findings carry fingerprints, so `filed()` is the dedupe. When the list
   * cannot be read, such a publisher files nothing in that run.
   */
  readonly fingerprints: boolean;
  /** Why it cannot publish now, such as a missing CLI. */
  ready(): Promise<Ready>;
  /** What every machine that publishes here has filed: the dedupe list. */
  filed(): Promise<Filed>;
  /** The issue's finding here, when this publisher has one for it. */
  ref(issue: Issue): Finding | undefined;
  /** Record the finding on the issue. The caller saves the issue. */
  link(issue: Issue, finding: Finding): void;
  /**
   * Upload or copy the screenshots before the finding exists. Returns the name
   * the report gives each path; a publisher that attaches them after `create`
   * returns local names and reads the paths from `CreateInput.images`.
   */
  images(issueId: string, paths: string[]): Promise<Map<string, string>>;
  /** How the report shows one image. Default: an HTML img tag. */
  renderImage?: (name: string, width: number) => string;
  create(input: CreateInput): Promise<Finding>;
  /** Close the issue's finding, with the evidence as a comment. Updates the issue's record of it. */
  close(issue: Issue, input: { as: 'fixed' | 'dismissed'; evidence: string }): Promise<void>;
  /** Reopen the issue's finding: Bugpatrol saw the problem again. Updates the issue's record of it. */
  reopen(issue: Issue, evidence: string): Promise<void>;
  /** Read the findings back: a dismissed one becomes a dismissal, a closed one a fix, a reopened one filed again. */
  sync(onLog?: (message: string) => void): Promise<{ changed: string[] }>;
  /** A fix PR needs a forge. Without this, a verified fix stays in the dashboard. */
  openPr?(input: {
    title: string;
    body: string;
    fix: FixProposal;
    issue: Issue;
  }): Promise<{ number: number; url: string }>;
  /** Recent merged PR titles, to teach the judge the repo's title style. */
  titleStyle?(): Promise<string[]>;
  /** Why a person dismissed the finding, when `filed()` leaves it out because reading it costs a call. */
  reasonFor?(finding: Finding): Promise<string | undefined>;
}

/** The publisher that the config selects (agents.publisher.use), or undefined when nothing is published. */
export function publisherFor(
  root: string,
  config: BugpatrolConfig,
  deps: { gh?: Gh; lattice?: LatticeRun; onLog?: (message: string) => void } = {},
): Publisher | undefined {
  switch (publisherOf(config)) {
    case 'github':
      return new GitHubPublisher(root, config, deps.gh ?? ghFor(config));
    case 'file':
      return new FilePublisher(root, config, { onLog: deps.onLog });
    case 'lattice':
      return new LatticePublisher(root, config, { run: deps.lattice, onLog: deps.onLog });
    default:
      return undefined;
  }
}

/** Close the issue's finding when the issue is fixed or dismissed. A failure is logged, never thrown. */
export async function closeFinding(
  root: string,
  config: BugpatrolConfig,
  issue: Issue,
  opts: { publisher?: Publisher; gh?: Gh; evidence?: string; onLog?: (message: string) => void } = {},
): Promise<void> {
  const onLog = opts.onLog ?? console.error;
  const publisher = opts.publisher ?? publisherFor(root, config, { gh: opts.gh, onLog });
  if (!publisher?.ref(issue)) return;
  try {
    const ready = await publisher.ready();
    if (!ready.ok) {
      onLog(ready.reason);
      return;
    }
    const evidence = [issue.closedBy?.reason ?? 'Fixed by Bugpatrol', opts.evidence].filter(Boolean).join('\n\n');
    await publisher.close(issue, { as: issue.status === 'dismissed' ? 'dismissed' : 'fixed', evidence });
    await new Workspace(root).saveIssue(issue);
  } catch (error) {
    onLog(`${publisher.label} close failed: ${String(error)}`);
  }
}

/** Read every finding's state back from the selected publisher. */
export async function syncFindings(
  root: string,
  config: BugpatrolConfig,
  deps: { gh?: Gh; publisher?: Publisher; onLog?: (message: string) => void } = {},
): Promise<{ changed: string[] }> {
  const publisher = deps.publisher ?? publisherFor(root, config, deps);
  return publisher ? publisher.sync(deps.onLog) : { changed: [] };
}
