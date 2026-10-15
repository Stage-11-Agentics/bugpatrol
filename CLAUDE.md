# Stage 11's Bugpatrol fork

`Stage-11-Agentics/bugpatrol` is Stage 11's public fork of `agent-labs-dev/bugpatrol`. It adds a
Handset driver (`packages/drivers/src/handset.ts`) so Bugpatrol can patrol apps on Handset's
leased devices. Never push to upstream; an upstream pull request goes from a branch cut from
upstream's `main`. `README.md` and `CONTRIBUTING.md` govern the code; this file covers what the
fork adds. `AGENTS.md` is a symlink to this file.

## CI: the Fast workflow

`.github/workflows/fast.yml` runs on every pull request and every push to `main`, as two parallel
jobs: `lint` (Biome, knip) and `test` (the TypeScript build and the hermetic tests).

- **Budget**, on each job's clock (runner start to last step, queue time not counted): push 30 s,
  pull request 60 s. Over budget is a defect: move the slowest test out or make it faster, and
  never raise a budget or a timeout to make a run fit. Each job's last step prints its clock and
  raises an `Over budget` warning. Hard caps: 1 minute on push, 2 on a pull request.
- **Measured** (cold: no TypeScript cache; warm: restored):

  | Event | Cache | lint | test | Run |
  |---|---|---|---|---|
  | pull request | cold | 23 s | 40 s | 38796195585 |

- **Where the speed comes from.** No dependency cache: restoring the 228 MB pnpm store takes 5 s,
  installing from the registry 3 to 6 s. No `actions/setup-node`: the runner image's Node is 22,
  and setup-node's version checks took 1 to 7 s. `test` does not install the site. TypeScript's
  incremental build (each `dist` and `tsconfig.tsbuildinfo`) is cached per commit and restored
  from the newest. Vitest runs with `--no-isolate`, 20 s down to 8.5 s for the push set; if a
  test fails only in Fast and passes alone, suspect state shared between files.
- **Quarantine.** `.github/fast/quarantine.txt` lists every test Fast leaves out, with its
  reason: six files that need Playwright's Chromium or ffmpeg, three review tests that need them,
  the dashboard test that waits a fixed 700 ms for a file watcher, and `review.test.ts` on push
  (16 s on its own; pull requests run it). Quarantine a slow or flaky test the day it shows with
  one line: `<path>`, `push: <path>` or `test: <exact test name>`, then `# reason`. Fix it and
  delete the line.
- **Run what Fast runs:** `pnpm build && bash .github/fast/test.sh`; prefix
  `GITHUB_EVENT_NAME=push` for the push set.
- **Every test has a timeout:** vitest's 5 s default, or its file's own `{ timeout }`.
- **The upstream workflows are disabled on this fork** with `gh workflow disable`: CI,
  Determinism, Review smoke, Pages and Release. They need Chromium, ffmpeg, model keys, Pages or
  npm publishing. Their files stay as upstream has them, so upstream pull requests stay small.
  They showed as active but had never run on a push or pull request here; GitHub's gate on a
  fork's inherited workflows is the likely cause. Re-enable one with
  `gh workflow enable <file> -R Stage-11-Agentics/bugpatrol`.
