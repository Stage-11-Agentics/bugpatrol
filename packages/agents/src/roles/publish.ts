import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  type BugpatrolConfig,
  type Candidate,
  type FixProposal,
  type Issue,
  judgedRetests,
  paths,
} from '@bugpatrol/core';
import type { Gh } from '../github.js';
import { buildPrTitle, PR_TYPES, templateScope } from '../pr-title.js';
import { judgePublishSystem } from '../prompts.js';
import { type Filed, type Finding, type Publisher, publisherFor } from '../publishers/index.js';
import { buildReport } from '../report.js';
import { createRuntime as makeRuntime } from '../runtime/index.js';
import { AgentSession } from '../session.js';
import type { Tool } from '../types.js';
import { Vars } from '../vars.js';
import { dismissByTracker, lessonsFor, Workspace } from '../workspace.js';

/**
 * `linked`: the publisher already had a finding with the issue's fingerprint.
 * `reopened`: a regression reopened its closed finding.
 */
export type PublishOutcome = {
  issueId: string;
  kind: 'pr' | 'issue' | 'skipped' | 'linked' | 'reopened';
  url?: string;
  reason?: string;
};
type Item = { kind: 'pr' | 'issue'; issue: Issue; fix?: FixProposal };
type Deps = {
  gh?: Gh;
  /** The publisher to use instead of the one the config selects. */
  publisher?: Publisher;
  createRuntime?: typeof makeRuntime;
  onLog?: (message: string) => void;
  onSession?: (session?: AgentSession) => void;
  issueIds?: string[];
  dryRun?: boolean;
};
const rank = { cosmetic: 0, minor: 1, major: 2, critical: 3 };

/**
 * A fix becomes a PR only when the retest proves it, or when no retest can
 * judge it (the retest is off, or the issue has no flow to replay). An
 * unclear or not-fixed fix stays in the dashboard.
 */
function publishable(fix: FixProposal): boolean {
  return fix.status === 'verified' || (fix.status === 'proposed' && !judgedRetests(fix.retests).length);
}
const result = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], isError });
const schema = (properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const string = { type: 'string' };

async function candidatesFor(workspace: Workspace, issue: Issue): Promise<Candidate[]> {
  const ids = new Set(issue.candidateIds);
  if (!ids.size) return [];
  const found = new Map<string, Candidate>();
  for (const session of await workspace.listSessions(Infinity)) {
    for (const candidate of await workspace.readCandidates(session.id))
      if (ids.has(candidate.id)) found.set(candidate.id, candidate);
    if (found.size === ids.size) break;
  }
  return issue.candidateIds.flatMap((id) => found.get(id) ?? []);
}

async function image(root: string, path?: string) {
  if (!path) return [];
  try {
    return [{ type: 'image' as const, png: await readFile(resolve(root, path)) }];
  } catch {
    return [];
  }
}

const day = (at: string) => at.slice(0, 10);

/** The comment that reopens a finding: when Bugpatrol saw the problem again, and what it saw. */
async function reopenEvidence(workspace: Workspace, issue: Issue): Promise<string> {
  const last = (await candidatesFor(workspace, issue)).at(-1);
  return [
    `Reopened by Bugpatrol: the problem was seen again on ${day(issue.regression?.at ?? issue.lastSeenAt)}, after the finding was closed as fixed.`,
    last ? `What it saw: ${last.summary}` : undefined,
    `Seen ${issue.occurrences} time(s), first ${day(issue.firstSeenAt)}, last ${day(issue.lastSeenAt)}.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * The publisher's findings that share a fingerprint with an issue that has no
 * finding yet. A finding filed from another machine, or before this
 * workspace's records, is linked rather than filed again.
 */
async function matchFiled(workspace: Workspace, items: Item[], findings: Finding[]): Promise<Map<string, Finding>> {
  const byFingerprint = new Map<string, Finding>();
  for (const finding of findings) for (const fp of finding.fingerprints ?? []) byFingerprint.set(fp, finding);
  const matches = new Map<string, Finding>();
  if (!byFingerprint.size) return matches;
  for (const item of items) {
    if (item.kind !== 'issue') continue;
    const fingerprints = [
      item.issue.fingerprint,
      ...(await candidatesFor(workspace, item.issue)).map((candidate) => candidate.fingerprint),
    ];
    const match = fingerprints.map((fp) => byFingerprint.get(fp)).find(Boolean);
    if (match) matches.set(item.issue.id, match);
  }
  return matches;
}

export async function runPublisher(root: string, config: BugpatrolConfig, deps: Deps = {}): Promise<PublishOutcome[]> {
  const publisher = deps.publisher ?? publisherFor(root, config, { gh: deps.gh });
  if (!publisher && !deps.dryRun) return [];
  const label = publisher?.label ?? 'GitHub';
  const workspace = new Workspace(root);
  const fixes = new Map((await workspace.listFixes()).map((fix) => [fix.issueId, fix]));
  // A dry run with no publisher reads GitHub's record, as a GitHub run would.
  const filedRef = (issue: Issue) => (publisher ? publisher.ref(issue) : issue.github);
  const canOpenPr = deps.dryRun || Boolean(publisher?.openPr);
  let waitingFixes = 0;
  const regressions: Issue[] = [];
  const items: Item[] = (await workspace.listIssues()).flatMap((issue): Item[] => {
    if (deps.issueIds && !deps.issueIds.includes(issue.id)) return [];
    if (issue.status === 'dismissed' || issue.publishSkipped || issue.fixRejected) return [];
    const fix = fixes.get(issue.id);
    if (fix?.status === 'rejected') return [];
    if (fix && !fix.pr && publishable(fix)) {
      if (canOpenPr) return [{ kind: 'pr' as const, issue, fix }];
      waitingFixes++;
      return [];
    }
    const ref = filedRef(issue);
    if (!deps.dryRun && publisher?.ref(issue)?.state === 'fixed' && issue.status === 'new' && issue.regression) {
      regressions.push(issue);
      return [];
    }
    if (
      !ref &&
      !['fixed', 'dismissed'].includes(issue.status) &&
      rank[issue.severity] >= rank[config.agents.github.issueMinSeverity] &&
      (!fix || ['declined', 'failed'].includes(fix.status))
    )
      return [{ kind: 'issue' as const, issue, fix }];
    return [];
  });
  if (waitingFixes)
    deps.onLog?.(
      `${waitingFixes} verified fix(es) stay in the dashboard: ${label} cannot open PRs. Fix PRs need a forge.`,
    );
  if (!items.length && !regressions.length) return [];
  if (!deps.dryRun) {
    const ready = await publisher!.ready();
    if (!ready.ok) {
      const record = await workspace.startSession('judge');
      await workspace.endSession(record.id, { summary: ready.reason });
      deps.onLog?.(ready.reason);
      return [];
    }
  }

  const outcomes: PublishOutcome[] = [];
  let filed: Filed = { findings: [], lines: [] };
  // The repo's own recent titles teach the judge its types and scopes.
  let recentTitles: string[] = [];
  if (!deps.dryRun && publisher) {
    try {
      recentTitles = (await publisher.titleStyle?.()) ?? [];
    } catch {
      /* Style hints are optional. */
    }
    try {
      filed = await publisher.filed();
    } catch {
      /* Without the list, the judge compares only the local items. */
    }
    // A finding with the issue's fingerprint is the same finding: link it, with no model.
    const matches = await matchFiled(workspace, items, filed.findings);
    const now = new Date().toISOString();
    for (const [issueId, finding] of matches) {
      const issue = items.find((item) => item.issue.id === issueId)!.issue;
      publisher.link(issue, finding);
      if (finding.state === 'dismissed')
        await dismissByTracker(
          workspace,
          issue,
          label,
          `Dismissed on ${label} as ${finding.name}.`,
          finding.stateAt ?? now,
        );
      else if (finding.state === 'fixed') {
        issue.regression = { at: now, fromStatus: 'fixed' };
        regressions.push(issue);
      } else issue.status = 'filed';
      await workspace.saveIssue(issue);
      // A fixed finding reopens below, and reports that.
      if (finding.state !== 'fixed') outcomes.push({ issueId, kind: 'linked', url: finding.url });
    }
    items.splice(0, items.length, ...items.filter((item) => !matches.has(item.issue.id)));
    // A regression reopens its finding. The judge already confirmed it, so no model is needed.
    for (const issue of regressions) {
      try {
        await publisher.reopen(issue, await reopenEvidence(workspace, issue));
        issue.status = 'filed';
        await workspace.saveIssue(issue);
        outcomes.push({ issueId: issue.id, kind: 'reopened', url: publisher.ref(issue)?.url });
      } catch (error) {
        deps.onLog?.(`${label} reopen of ${issue.id} failed: ${String(error)}`);
      }
    }
  }
  if (!items.length) return outcomes;

  const vars = new Vars(config.app.secrets);
  const record = await workspace.startSession('judge');
  const session = new AgentSession(root, config, vars, record.id, 'judge', undefined, deps.onLog);
  deps.onSession?.(session);
  const done = new Set<string>();
  const runtime = (deps.createRuntime ?? makeRuntime)(config.agents.judge.use);
  let steps = 0;
  let costUsd = 0;
  let status: 'finished' | 'failed' = 'finished';
  const get = (id: string) => items.find((item) => item.issue.id === id && !done.has(id));
  const pathsFor = (item: Item, candidates: Candidate[]) =>
    new Set(
      [
        item.issue.evidence.screenshot,
        ...candidates.map((candidate) => candidate.evidence.screenshot),
        ...(item.fix?.retests ?? []).flatMap((retest) => [
          retest.before,
          retest.after,
          ...(retest.shots ?? []).flatMap((shot) => [shot.before, shot.after]),
        ]),
      ].filter((path): path is string => Boolean(path)),
    );
  const defaultScope = config.agents.github.prScope ?? templateScope(config.agents.fixer.commitMessage);
  try {
    await session.activity(`Publishing ${items.length} item(s)`, 0, runtime.label);
    session.emit({ kind: 'session-start', summary: `Publishing ${items.length} item(s) to ${label}` });
    const tools: Tool[] = [
      {
        name: 'list_items',
        description: 'List issues ready to publish.',
        inputSchema: schema(),
        async run() {
          const list = items
            .filter((item) => !done.has(item.issue.id))
            .map(
              (item) =>
                `${item.issue.id} [${item.kind}, ${item.issue.severity}, fix: ${item.fix?.status ?? 'none'}, retest: ${item.fix?.retests?.at(-1)?.outcome ?? 'none'}]: ${item.issue.title}`,
            )
            .join('\n');
          const style = recentTitles.length
            ? `\n\nRECENT MERGED PR TITLES IN THIS REPO (use the same types and scopes)\n${recentTitles.map((t) => `- ${t}`).join('\n')}`
            : '';
          const scope = defaultScope ? `\nDefault PR scope: ${defaultScope}` : '';
          const already = filed.lines.length
            ? `\n\nALREADY ON ${label.toUpperCase()} (from every Bugpatrol run)\n${filed.lines.join('\n')}`
            : '';
          return result(vars.redact(`${list}${scope}${already}${style}`) as string);
        },
      },
      {
        name: 'view_item',
        description: 'Review an item and its before and after screenshots.',
        inputSchema: schema({ issue_id: string }, ['issue_id']),
        async run(input) {
          const item = get(String(input.issue_id));
          if (!item) return result('Unknown or already handled issue.', true);
          const candidates = await candidatesFor(workspace, item.issue);
          const last = item.fix?.retests?.at(-1);
          const text = `${item.issue.title}\n${item.issue.body}\nJudgement: ${item.issue.judgement.reason}\nFix: ${item.fix?.summary ?? '(none)'}\nDiff: ${item.fix?.diffStat ?? '(none)'}\nRetest: ${last?.outcome ?? 'none'} — ${last?.reason ?? ''}`;
          const before = [...pathsFor({ ...item, fix: undefined }, candidates)].slice(0, 4);
          const after = (last?.shots?.length ? last.shots.map((shot) => shot.after) : [last?.after])
            .filter((path): path is string => Boolean(path))
            .slice(0, 4);
          const content: Awaited<ReturnType<Tool['run']>>['content'] = [
            { type: 'text', text: vars.redact(text) as string },
          ];
          for (const path of [...before, ...after]) content.push(...(await image(root, path)));
          return { content };
        },
      },
      {
        name: 'publish',
        description: 'Publish the reviewed item with a short team summary.',
        inputSchema: schema(
          {
            issue_id: string,
            title: {
              type: 'string',
              description:
                'For an issue: the user-visible problem. For a PR: the description part only, e.g. "expand the sidebar in a narrow window".',
            },
            type: { type: 'string', enum: [...PR_TYPES], description: 'PR only: the Conventional Commits type.' },
            scope: {
              type: 'string',
              description: 'PR only, optional: the scope, e.g. app. Use a scope that the repo uses.',
            },
            summary: string,
          },
          ['issue_id', 'title', 'summary'],
        ),
        async run(input) {
          const item = get(String(input.issue_id));
          if (!item) return result('Unknown or already handled issue.', true);
          let title = (vars.redact(String(input.title ?? '')) as string).trim();
          const summary = String(input.summary ?? '').trim();
          if (!summary) return result('The summary is missing.', true);
          if (item.kind === 'pr') {
            if (!input.type) return result(`A PR needs a type: one of ${PR_TYPES.join(', ')}.`, true);
            const built = buildPrTitle({
              type: String(input.type),
              scope: input.scope ? String(input.scope) : defaultScope,
              description: title,
            });
            if (!built.ok) return result(built.reason, true);
            title = built.title;
          } else if (!title || title.length > 80) {
            // The length in the error lets the model cut the title in one retry.
            return result(`The title has ${title.length} characters; the limit is 80. Write a shorter title.`, true);
          }
          try {
            const latestIssue = await workspace.readIssue(item.issue.id);
            const latestFix = item.fix && (await workspace.readFix(item.fix.id));
            if (
              !latestIssue ||
              latestIssue.status === 'dismissed' ||
              latestIssue.publishSkipped ||
              latestIssue.fixRejected ||
              latestFix?.status === 'rejected' ||
              (item.kind === 'issue' && filedRef(latestIssue)) ||
              (item.kind === 'pr' && (!latestFix || latestFix.pr))
            )
              return result('This item was dismissed or already handled.', true);
            Object.assign(item.issue, latestIssue);
            if (item.fix && latestFix) Object.assign(item.fix, latestFix);
            const candidates = await candidatesFor(workspace, item.issue);
            const shots = [...pathsFor(item, candidates)];
            const urls = deps.dryRun
              ? new Map(shots.map((path) => [path, path]))
              : await publisher!.images(item.issue.id, shots);
            const body = buildReport({
              kind: item.kind,
              summary,
              issue: item.issue,
              candidates,
              fix: item.fix,
              imageUrl: (path) => urls.get(path),
              renderImage: deps.dryRun ? undefined : publisher!.renderImage,
              redact: (text) => vars.redact(text) as string,
              closes: item.kind === 'pr' ? item.issue.github?.number : undefined,
            });
            let url: string;
            let name = '';
            if (deps.dryRun) {
              const dir = paths.publish(root);
              await mkdir(dir, { recursive: true });
              url = join(dir, `${item.issue.id}.md`);
              await writeFile(url, body);
            } else if (item.kind === 'pr' && item.fix) {
              const opened = await publisher!.openPr!({ title, body, fix: item.fix, issue: item.issue });
              url = opened.url;
              item.fix.pr = {
                ...opened,
                draft: config.agents.github.pullRequests === 'draft',
                at: new Date().toISOString(),
              };
              await workspace.saveFix(item.fix);
            } else {
              const finding = await publisher!.create({
                issue: item.issue,
                title,
                body,
                fingerprints: [...new Set([item.issue.fingerprint, ...candidates.map((c) => c.fingerprint)])],
                images: urls,
              });
              url = finding.url;
              name = finding.name;
              publisher!.link(item.issue, finding);
              item.issue.status = 'filed';
              await workspace.saveIssue(item.issue);
            }
            done.add(item.issue.id);
            outcomes.push({ issueId: item.issue.id, kind: item.kind, url });
            session.emit({
              kind: 'issue',
              summary: deps.dryRun
                ? `Drafted ${item.kind}: ${title}`
                : item.kind === 'pr'
                  ? `Opened PR #${url.split('/').at(-1)}: ${title}`
                  : `Opened ${label} issue ${name}: ${title}`,
              output: url,
            });
            return result(url);
          } catch (error) {
            if (item.fix?.commit) await workspace.saveFix(item.fix);
            return result(String(error), true);
          }
        },
      },
      {
        name: 'skip',
        description: 'Skip only when this is clearly not a product bug.',
        inputSchema: schema({ issue_id: string, reason: string }, ['issue_id', 'reason']),
        async run(input) {
          const item = get(String(input.issue_id));
          if (!item) return result('Unknown or already handled issue.', true);
          const reason = String(input.reason ?? '').trim();
          if (!reason) return result('A reason is required.', true);
          const latest = await workspace.readIssue(item.issue.id);
          if (!latest || latest.status === 'dismissed' || latest.publishSkipped)
            return result('This item was dismissed or already handled.', true);
          Object.assign(item.issue, latest);
          item.issue.publishSkipped = { reason: vars.redact(reason) as string, at: new Date().toISOString() };
          if (!deps.dryRun) await workspace.saveIssue(item.issue);
          done.add(item.issue.id);
          outcomes.push({ issueId: item.issue.id, kind: 'skipped', reason });
          return result(`Skipped ${item.issue.id}: ${reason}`);
        },
      },
      {
        name: 'finish',
        description: 'Finish the publishing session.',
        inputSchema: schema({ summary: string }, ['summary']),
        async run(input) {
          return { ...result(String(input.summary ?? '')), done: true };
        },
      },
    ];
    const outcome = await runtime.run(
      {
        role: 'judge',
        sessionId: record.id,
        system: judgePublishSystem(lessonsFor(await workspace.readMemory(), 'judge'), label),
        prompt: vars.redact(
          `${deps.dryRun ? `DRY RUN: publish writes a local draft file, and nothing goes to ${label}. Say "drafted", not "published".\n` : ''}Review and publish these items:\n${items.map((item) => `${item.issue.id}: ${item.issue.title}`).join('\n')}`,
        ) as string,
        tools: tools.map((tool) => ({
          ...tool,
          async run(input) {
            if (session.cancelled) return result('Session cancelled.', true);
            return tool.run(input);
          },
        })),
        maxSteps: Math.max(config.agents.judge.maxSteps, 3 * items.length + 5),
        budgetUsd: config.agents.judge.budgetUsd,
        timeoutMs: config.agents.judge.timeoutMs,
      },
      session.emit,
    );
    steps = outcome.steps;
    costUsd = outcome.costUsd;
  } catch (error) {
    status = 'failed';
    session.emit({ kind: 'error', summary: `${label} publishing failed: ${String(error)}` });
    deps.onLog?.(`${label} publishing failed: ${String(error)}`);
  } finally {
    const prs = outcomes.filter((item) => item.kind === 'pr').length;
    const issues = outcomes.filter((item) => item.kind === 'issue').length;
    const skipped = outcomes.filter((item) => item.kind === 'skipped').length;
    const summary = `${deps.dryRun ? 'Drafted' : 'Published'} ${prs} PR(s) and ${issues} issue(s); skipped ${skipped}`;
    await workspace.endSession(record.id, { summary, status, steps, costUsd });
    session.emit({ kind: 'session-end', summary });
    await session.idle(costUsd);
    deps.onSession?.();
  }
  return outcomes;
}
