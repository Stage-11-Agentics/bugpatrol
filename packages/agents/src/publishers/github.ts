import { resolve } from 'node:path';
import type { BugpatrolConfig, FixProposal, Issue } from '@bugpatrol/core';
import {
  closeIssue,
  createIssue,
  createPr,
  ensureAssetsBranch,
  ensureLabels,
  type Gh,
  ghReady,
  listFiled,
  resolveRepo,
  syncGitHub,
  uploadImage,
} from '../github.js';
import { isConventional } from '../pr-title.js';
import type { CreateInput, Filed, Finding, Publisher, Ready } from './index.js';

/**
 * Findings as GitHub issues, screenshots on an orphan assets branch, fixes as
 * PRs. GitHub issues carry no fingerprint marker, so the publish judge reads
 * the filed list to skip a duplicate.
 */
export class GitHubPublisher implements Publisher {
  readonly name = 'github' as const;
  readonly label = 'GitHub';
  readonly fingerprints = false;
  private repo?: { repo: string; defaultBranch: string };
  private assetsReady = false;
  private labelsReady = false;

  constructor(
    private readonly root: string,
    private readonly config: BugpatrolConfig,
    private readonly gh: Gh,
  ) {}

  ready(): Promise<Ready> {
    return ghReady(this.gh);
  }

  private async resolved(): Promise<{ repo: string; defaultBranch: string }> {
    this.repo ??= await resolveRepo(this.gh, this.config, resolve(this.root, this.config.app.source));
    return this.repo;
  }

  private async labels(repo: string): Promise<void> {
    if (this.labelsReady) return;
    await ensureLabels(this.gh, repo, this.config.agents.github.labels);
    this.labelsReady = true;
  }

  async filed(): Promise<Filed> {
    const { repo } = await this.resolved();
    return { findings: [], lines: await listFiled(this.gh, repo, this.config) };
  }

  async titleStyle(): Promise<string[]> {
    const { repo } = await this.resolved();
    const titles = await this.gh([
      'pr',
      'list',
      '--repo',
      repo,
      '--state',
      'merged',
      '--limit',
      '25',
      '--json',
      'title',
      '-q',
      '.[].title',
    ]);
    return titles.split('\n').filter(isConventional).slice(0, 10);
  }

  ref(issue: Issue): Finding | undefined {
    const github = issue.github;
    if (!github) return undefined;
    return {
      id: String(github.number),
      name: `#${github.number}`,
      title: issue.title,
      url: github.url,
      state: github.state === 'closed' ? (github.stateReason === 'not_planned' ? 'dismissed' : 'fixed') : 'open',
      stateAt: github.stateAt,
    };
  }

  link(issue: Issue, finding: Finding): void {
    issue.github = {
      number: Number(finding.id),
      url: finding.url,
      at: new Date().toISOString(),
      ...(finding.state === 'open'
        ? {}
        : {
            state: 'closed' as const,
            stateReason: finding.state === 'dismissed' ? ('not_planned' as const) : ('completed' as const),
            stateAt: finding.stateAt,
          }),
    };
  }

  async images(issueId: string, paths: string[]): Promise<Map<string, string>> {
    const { repo } = await this.resolved();
    const branch = this.config.agents.github.assetsBranch;
    if (!this.assetsReady) {
      await ensureAssetsBranch(this.gh, repo, branch);
      this.assetsReady = true;
    }
    const urls = new Map<string, string>();
    for (const path of paths)
      urls.set(path, await uploadImage(this.gh, repo, branch, resolve(this.root, path), issueId));
    return urls;
  }

  async create(input: CreateInput): Promise<Finding> {
    const { repo } = await this.resolved();
    await this.labels(repo);
    const opened = await createIssue(this.gh, {
      repo,
      title: input.title,
      body: input.body,
      labels: this.config.agents.github.labels,
    });
    return { id: String(opened.number), name: `#${opened.number}`, title: input.title, url: opened.url, state: 'open' };
  }

  async openPr(input: { title: string; body: string; fix: FixProposal; issue: Issue }) {
    const { repo, defaultBranch } = await this.resolved();
    await this.labels(repo);
    return createPr(this.gh, {
      repo,
      defaultBranch,
      title: input.title,
      body: input.body,
      labels: this.config.agents.github.labels,
      draft: this.config.agents.github.pullRequests === 'draft',
      fix: input.fix,
      issue: input.issue,
      commitMessage: input.title,
      memoryRoot: this.root,
    });
  }

  async close(issue: Issue, input: { as: 'fixed' | 'dismissed'; evidence: string }): Promise<void> {
    if (!issue.github) return;
    const { repo } = await this.resolved();
    await closeIssue(
      this.gh,
      repo,
      issue.github.number,
      input.evidence,
      input.as === 'dismissed' ? 'not planned' : 'completed',
    );
    issue.github = {
      ...issue.github,
      state: 'closed',
      stateReason: input.as === 'dismissed' ? 'not_planned' : 'completed',
      stateAt: new Date().toISOString(),
    };
  }

  async reopen(issue: Issue, evidence: string): Promise<void> {
    if (!issue.github) return;
    const { repo } = await this.resolved();
    await this.gh(['issue', 'reopen', String(issue.github.number), '--repo', repo, '--comment', evidence]);
    issue.github = { ...issue.github, state: 'open', stateReason: 'reopened', stateAt: undefined };
  }

  sync(onLog?: (message: string) => void): Promise<{ changed: string[] }> {
    return syncGitHub(this.root, this.config, { gh: this.gh, onLog });
  }
}
