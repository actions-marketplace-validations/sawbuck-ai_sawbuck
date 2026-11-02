# sawbuck

**Sign your agent to a contract so it does what you want.**

A saddle for your coding harness. You write the contract (what a real win looks like); Sawbuck enforces it, re-proving every win from the agent's **source** edits alone, so a result that only passed because the agent edited the test, mocked the grader, or loosened a rule gets flagged and reverted. Deterministic, zero-LLM, un-gameable. Break it in and it carries your repo's history along: what broke in these files before, surfaced before you touch them.

> Sawbuck is the reference implementation of the [Verified-Outcome Contract](CONTRACT.md): the open interface for a coding loop you can trust.

```sh
# 1 · try it (no install, no commitment): verify your latest change right now
npx sawbuck check

# 2 · watch it live: attach once to this repo (a project-scoped Claude Code hook)
npm i -g sawbuck
sawbuck attach --claude
```

**Zero-config:** it auto-detects your test command, so there is nothing to write to start.
On attach it tells you exactly what it can measure here (and how to fix it if it can't).
`sawbuck init` is only for *customizing* what it measures (coverage, latency, a cost budget).
In CI instead of a local hook? use the GitHub Action. For every project at once: `sawbuck attach --user`.

On each change:

```
$ sawbuck check
sawbuck: gamed recorded on test.js       (the win came from editing the test, not the source)
```

## What it does

- **Verifies the win.** `check` re-runs your metric from the source diff alone. A faked green (a deleted, weakened, or skipped test; a mocked grader; an edited golden file) reads `gamed`. Deterministic, zero-LLM, $0, and it cannot be obfuscated against because it never reads the trajectory (89% recall on a labeled gaming benchmark).
- **Remembers what broke.** `context` and `rank` surface the relevant history (reverts, fragile areas, test-weakening) for the files you are touching: a ranked trail guide, before you act.
- **Shows you everything.** `status` is the inventory: what it has caught for you over time, the debt accruing now, and whether it is armed here, in one view. On-demand, so it is quiet until you go looking.
- **Rides on, does not replace.** Sawbuck is the verify + memory layer. Your agent and your loop stay yours.
- **Clean on and off.** `attach` touches nothing in your worktree (the hook lives in `.git/`, the record is excluded locally); `detach` is a true inverse. `trace` shows every byte it placed, and `detach --verify` proves the repo came back unchanged.

## Commands

| command | what |
|---|---|
| `sawbuck attach [--claude \| --user]` | wire the reflex (git post-commit / project Claude hooks / user-level for every project) |
| `sawbuck detach [--claude \| --user]` | remove it |
| `sawbuck check [--base R --head R]` | verify a commit; record a regression or a gamed win |
| `sawbuck context` · `sawbuck rank` | the ranked relevant history for the current change |
| `sawbuck debt` | the whole-repo live suppression debt: what is still silenced in HEAD now, disabled tests first, heaviest files ranked |
| `sawbuck status` · `sawbuck log` | the inventory (caught over time + debt now + armed state), in one view; and the recent per-check feed |
| `sawbuck recall` | related notes for your current change from extra memory providers you compose in (bring your own) |
| `sawbuck run --attempt '<agent cmd>'` | thin harness: load context, run one attempt through the keep-if-verified gate |
| `sawbuck trace` · `sawbuck doctor` · `detach --verify` | show the footprint; check the attachment resolves; prove a clean removal |
| `sawbuck where` · `sawbuck statusline` | list every repo it is attached to; a one-line status-line segment (🐴 watching / N caught) |

## Give your agent the contract

`sawbuck init` writes this block into your `AGENTS.md` for you (and `CLAUDE.md` / `.cursorrules` if present; `--no-agent-block` to skip), and `sawbuck attach --claude` enforces the same thing every turn via the hook. Here it is to paste yourself if you want:

    This repo is under a Sawbuck contract: a change is done only when the win survives verification
    from the source alone. Before finishing, run `sawbuck check`. If it reads `gamed`, the green came
    from editing a test, config, or grader, not the source, so undo that and earn it in the source.
    Run `sawbuck context` first to see what broke in these files before (reverts, weakened tests,
    fragile spots). Never skip, weaken, or delete a test to go green.

Each repo needs a `promptwheel.config.json` saying what to measure (your tests, lint, coverage, or an eval).

## Gate debt on pull requests

`sawbuck debt --since <base>` shows only the suppression debt a branch adds. Fail the build when a PR adds the kind you care about:

```yaml
# .github/workflows/debt.yml
name: debt
on: pull_request
jobs:
  debt:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }   # the base ref must be present to diff against
      - run: npx -y sawbuck debt --since "origin/${{ github.base_ref }}" --fail-on undocumented
```

`--fail-on` takes `undocumented` (a bare `# type: ignore` / `# noqa` with no code), `test` (a newly disabled test), `any`, or a number of new suppressions. Exit 1 fails the check; add `--json` for the machine-readable delta. This repo is also a composite action: `uses: sawbuck-ai/sawbuck@v0` with `base` and `fail-on` inputs.

Debt also rises on its own: once attached, the per-turn `context` hook surfaces the live suppression debt on the files your agent is touching when it is the suspect kind (undocumented, a disabled test, or on code that keeps breaking), so you do not have to run anything.

## The engines

Sawbuck is thin glue over two roles, each behind an open interface that points in opposite directions:

- **the check** : the deterministic outcome gate, a published standard (the [Verified-Outcome Contract](CONTRACT.md)) that others conform to. Reference implementation: **promptwheel**. You plug in *what* to measure (your tests, lint, coverage, an eval); the un-gameable source re-proof is the fixed part. Embed it with `import { check }`, or check any tool's verdict with `promptwheel conformance`.
- **the memory** : the relevant history for the files you touch, plus the live debt. A socket you can fill. Default provider: **@promptwheel/logbook** (git history as agent memory; also ships an MCP server). Sawbuck reads it through one adapter, so you can *compose in your own* memory: `SAWBUCK_MEMORY=logbook,obsidian` keeps logbook as the git-truth + debt provider and adds your notes, then `sawbuck recall`. Four reference providers ship in `providers/`: **obsidian** (local notes vault; set `OBSIDIAN_VAULT`), **local** (a plain JSON file, zero setup), **claude** (read-only: your project's `CLAUDE.md` / `.claude` memory, already there, nothing to configure), and **mem0** (semantic memory; the one that reaches the network, so it needs a `MEM0_API_KEY` or a `~/.mem0` key file, unlike the offline default; verified against Mem0's v3 API). Any bin that speaks the three contract verbs works; `sawbuck memory-conformance <bin>` checks one. Composed providers are **folder-scoped and isolated by default**: each repo sees only its own memory, never a sibling's. Drop a `.sawbuck-root` marker (or set `SAWBUCK_MEMORY_ROOT`) in a parent folder to let repos under it inherit that folder's shared memory, top down. logbook is the default, not a hard requirement of the idea.

In one line: the check is a standard we publish for others to meet; the memory is a socket we expose for others to fill. Sawbuck composes the two.

Apache 2.0.
