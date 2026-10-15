#!/usr/bin/env bash
# Reports this job's clock against its budget, and warns when it is over.
#
# The clock is GitHub's job clock: from the moment a runner starts the job
# (queue time is not counted) to this step. Over budget is a defect. Move the
# slowest test out (.github/fast/quarantine.txt) or make it faster; never
# raise FAST_BUDGET to make a run fit.
set -o pipefail

budget=${FAST_BUDGET:?FAST_BUDGET is not set}
started=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/attempts/$GITHUB_RUN_ATTEMPT/jobs" \
  --jq '[.jobs[] | select(.runner_name == env.RUNNER_NAME or .name == env.GITHUB_JOB)][0].started_at // empty' 2>/dev/null)
if [ -z "$started" ]; then
  echo "::warning title=No job clock::Could not read when $GITHUB_JOB started from the Actions API."
  exit 0
fi

elapsed=$(($(date +%s) - $(date -d "$started" +%s)))
line="$GITHUB_JOB took ${elapsed}s against its ${budget}s $GITHUB_EVENT_NAME budget"
echo "$line."
echo "- $line." >>"$GITHUB_STEP_SUMMARY"
if [ "$elapsed" -gt "$budget" ]; then
  echo "::warning title=Over budget::$line. Over budget is a defect: move the slowest test out (.github/fast/quarantine.txt) or make it faster. Never raise the budget."
fi
