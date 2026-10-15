# Stage 11's Bugpatrol fork

`Stage-11-Agentics/bugpatrol` is Stage 11's public fork of `agent-labs-dev/bugpatrol`. It adds a
Handset driver (`packages/drivers/src/handset.ts`) so Bugpatrol can patrol apps on Handset's
leased devices. Never push to upstream; an upstream pull request goes from a branch cut from
upstream's `main`. `README.md` and `CONTRIBUTING.md` govern the code; this file covers what the
fork adds. `AGENTS.md` is a symlink to this file.

A checkout with both remotes and no `gh` default sends `gh pr`, `gh run` and `gh workflow` to
upstream. Run `gh repo set-default Stage-11-Agentics/bugpatrol` once per checkout, or pass
`-R Stage-11-Agentics/bugpatrol`.

## CI: the Fast workflow

`.github/workflows/fast.yml` runs on every pull request and every push to `main`, as two parallel
jobs: `lint` (Biome, knip) and `test` (the TypeScript build, the hermetic tests, and on pull
requests the npm bundle).

- **Budget** on GitHub's job clock (a runner starting the job to its completion; queue time is
  not counted): push 30 s, pull request 60 s. Over budget is a defect: move the slowest test out
  or make it faster, and never raise a budget or a timeout to make a run fit. Each job's last
  step prints its clock and raises an `Over budget` warning; it never fails the job, so runner
  noise cannot block a merge. Hard caps: 1 minute on push, 2 on a pull request.
- **Measured** on the job clock (cold: no cache of node_modules or of the TypeScript build):

  | Event | Cache | lint | test | Run |
  |---|---|---|---|---|
  | push to `main` | cold | 22 s | 29 s | 38801868319, attempt 1 |
  | push to `main` | warm | 10 s | 18 s | 38801868319, attempt 2 |
  | pull request | dependencies cold | 64 s | 55 s | 38801474179, attempt 1 |
  | pull request | dependencies warm | 16 s | 36 s | 38801474179, attempt 2 |

  The cold pull request lost 51 s to the registry, which is why node_modules is cached. Both
  pull request rows restored a stale TypeScript cache from their own branch (10 s); one that
  restores `main`'s spends 2 to 3 s. A run that misses the dependency cache installs from the
  registry and spends 3 to 5 s saving it, so a push that misses can run over its budget once. It
  misses after a change to the lockfile, `pnpm-workspace.yaml`, any `package.json` or `.npmrc`,
  and after 7 days without a push to `main`; a pull request's own save is not visible to `main`.

- **Where the speed comes from.** Nothing reaches a registry on a cache hit: node_modules and
  corepack's copy of pnpm are cached for the exact lockfile and package.json files. They restore
  in 2 s without the site (93 MB, the `test` job) and 5 s with it (220 MB, `lint`, whose knip
  reads the site). From the registry, the install took 3 to 51 s, and
  `pnpm/action-setup`'s download of pnpm 1 to 20 s. No `actions/setup-node`: the jobs pin
  `ubuntu-24.04`, whose Node is 22, and setup-node's version checks took 1 to 7 s.
  TypeScript's incremental build (each `dist` and `tsconfig.tsbuildinfo`) is saved from `main`
  and restored by everything else: 2 to 3 s warm, 10 to 11 s cold. Vitest runs with
  `--no-isolate`, which cut the files outside `review.test.ts` from 20 s to 8.5 s. If a test
  fails only in Fast and passes alone, suspect state shared between test files.
- **Quarantine.** `.github/fast/quarantine.txt` lists everything Fast leaves out, with the
  reason: five files and six tests that need Playwright's Chromium or ffmpeg, one dashboard test
  that waits a fixed 700 ms for a file watcher, and three files over 3 s that run on pull
  requests only. Quarantine a slow or flaky test the day it shows, with one line (`<path>`,
  `push: <path>` or `test: <end of its full name>`, then `# reason`). Fix it and delete the line.
- **Runs nowhere on this fork:** the quarantined tests, the site's typecheck and build, and the
  suite with each file isolated (`pnpm test`). Upstream's CI runs them on an upstream pull
  request.
- **Run what Fast runs:** `pnpm build && bash .github/fast/test.sh`; prefix
  `GITHUB_EVENT_NAME=push` for the push set.
- **Every test has a timeout:** vitest's 5 s default, or its file's own `{ timeout }`.
- **The upstream workflows are disabled on this fork** with `gh workflow disable`: CI,
  Determinism, Review smoke, Pages and Release. They need Chromium, ffmpeg, model keys, Pages or
  npm publishing. Their files stay as upstream has them, so upstream pull requests stay small.
  They showed as active but never ran on a push or pull request here; GitHub's gate on a fork's
  inherited workflows is the likely cause. Re-enable one with
  `gh workflow enable <file> -R Stage-11-Agentics/bugpatrol`.
