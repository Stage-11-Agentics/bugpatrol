#!/usr/bin/env bash
# Runs the hermetic tests the way the Fast workflow does: every test file
# except what .github/fast/quarantine.txt leaves out, with --no-isolate (the
# files of a worker share one module graph; 2.4 times faster on the runner).
# Build first (pnpm build): the packages import each other's dist.
#
#   bash .github/fast/test.sh                          as a pull request runs it
#   GITHUB_EVENT_NAME=push bash .github/fast/test.sh   as a push to main runs it
#
# Extra arguments go to vitest.
set -eo pipefail
cd "$(dirname "$0")/../.."

event=${GITHUB_EVENT_NAME:-pull_request}
args=()
names=()
trim() { sed -E 's/^[[:space:]]+|[[:space:]]+$//g' <<<"$1"; }
exclude() {
  if [ ! -e "$1" ]; then
    echo "::warning title=Stale quarantine entry::$1 does not exist; remove it from .github/fast/quarantine.txt."
  fi
  args+=(--exclude "$1")
}

while IFS= read -r line || [ -n "$line" ]; do
  entry=$(trim "${line%%#*}")
  case $entry in
    '') ;;
    push:*)
      if [ "$event" = push ]; then exclude "$(trim "${entry#push:}")"; fi
      ;;
    test:*) names+=("$(trim "${entry#test:}")") ;;
    *) exclude "$entry" ;;
  esac
done <.github/fast/quarantine.txt

echo "Left out of this $event run (see .github/fast/quarantine.txt):"
for ((i = 1; i < ${#args[@]}; i += 2)); do echo "  file  ${args[i]}"; done
for name in "${names[@]}"; do echo "  test  $name"; done

if [ ${#names[@]} -gt 0 ]; then
  # Skip each named test: a full name must not end with any of them.
  pattern=$(printf '%s\n' "${names[@]}" | sed -E 's/[][(){}.*+?^$|\\/]/\\&/g' | paste -sd '|' -)
  args+=(--testNamePattern "^(?!.*(?:$pattern)$)")
fi

exec pnpm exec vitest run --no-isolate "${args[@]}" "$@"
