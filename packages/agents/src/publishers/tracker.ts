import { relative } from 'node:path';
import type { Issue, PublishedRef } from '@bugpatrol/core';
import { dismissByTracker, Workspace } from '../workspace.js';
import type { Finding, Publisher } from './index.js';

/** How a ref names its target: relative to the project root, so the project can move. */
export function trackerTarget(root: string, dir: string): string {
  return relative(root, dir) || '.';
}

/** The issue's ref on this publisher's target, or undefined when it has none there. */
export function refOn(issue: Issue, name: string, target: string): PublishedRef | undefined {
  const ref = issue.published?.[name];
  return ref?.target === target ? ref : undefined;
}

export function asFinding(issue: Issue, ref: PublishedRef): Finding {
  return { id: ref.id, name: ref.name, title: issue.title, url: ref.url, state: ref.state, stateAt: ref.stateAt };
}

export function setRef(issue: Issue, name: string, target: string, finding: Finding): void {
  issue.published = {
    ...issue.published,
    [name]: {
      id: finding.id,
      name: finding.name,
      url: finding.url,
      at: new Date().toISOString(),
      target,
      state: finding.state,
      stateAt: finding.stateAt,
    },
  };
}

/**
 * Read each finding's state back onto its issue, for a publisher whose
 * findings carry their state (a file, a Lattice task). A person who dismisses
 * a finding there dismisses the issue here, and the judge does not file it
 * again; a closed finding is a fix; a reopened one is filed again.
 */
export async function syncTracker(
  root: string,
  publisher: Publisher,
  name: string,
  target: string,
  onLog?: (message: string) => void,
): Promise<{ changed: string[] }> {
  const workspace = new Workspace(root);
  const issues = (await workspace.listIssues()).filter((issue) => refOn(issue, name, target));
  if (!issues.length) return { changed: [] };
  const byId = new Map((await publisher.filed()).findings.map((finding) => [finding.id, finding]));
  const changed: string[] = [];
  const now = new Date().toISOString();
  for (const issue of issues) {
    const ref = refOn(issue, name, target)!;
    const remote = byId.get(ref.id);
    if (!remote) {
      onLog?.(`${issue.id}: its finding ${ref.name} is no longer on ${publisher.label}; the issue stays as it is.`);
      continue;
    }
    if (remote.unknownState) continue;
    const transition = remote.state !== ref.state;
    const stale = !ref.checkedAt || Date.parse(now) - Date.parse(ref.checkedAt) >= 3_600_000;
    if (!transition && !stale) continue;
    if (transition) {
      changed.push(issue.id);
      const at = remote.stateAt ?? now;
      if (remote.state === 'dismissed') {
        const why = remote.reason ?? (await publisher.reasonFor?.(remote));
        const reason = why ? `${why} (${remote.name})` : `Dismissed on ${publisher.label} as ${remote.name}.`;
        await dismissByTracker(workspace, issue, publisher.label, reason, at);
      } else if (remote.state === 'fixed') {
        issue.status = 'fixed';
        issue.closedBy = { by: publisher.label, reason: `Closed on ${publisher.label} as fixed (${remote.name}).`, at };
      } else if (issue.status === 'fixed' || issue.status === 'dismissed') {
        // A person reopened it. Work under way on the issue keeps its status.
        issue.status = 'filed';
        issue.closedBy = undefined;
      }
    }
    ref.state = remote.state;
    ref.stateAt = remote.stateAt;
    ref.checkedAt = now;
    await workspace.saveIssue(issue);
  }
  return { changed };
}
