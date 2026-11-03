# sawbuck

**Sign your agent to a contract so it does what you want.**

You write the contract (what a real win looks like); Sawbuck enforces it, re-proving every win from the agent's **source** edits alone, so a result that only passed because the agent edited the test, mocked the grader, or loosened a rule reads `gamed` and goes back. Deterministic and zero-LLM: no model in the verdict, nothing read from the agent's trajectory. Attach it and it carries your repo's history along: what broke in these files before, surfaced before you touch them.

> Sawbuck is the reference implementation of the [Verified-Outcome Contract](CONTRACT.md): the open interface for a coding loop you can trust.

```sh
# 1 · try it (no install, no commitment): verify your latest change right now
npx sawbuck check

# 2 · enforce it: attach once to this repo
npm i -g sawbuck
sawbuck attach            # every commit (a git post-commit hook)
sawbuck attach --claude   # or every Claude Code turn (a project-scoped Stop hook)
```

**Zero-config:** it auto-detects your test command, so there is nothing to write to start.
On attach it tells you exactly what it can measure here (and how to fix it if it can't).
`sawbuck init` is only for *customizing* what counts (coverage, latency, a cost budget, a protected path).
In CI, the same check runs as the [promptwheel GitHub Action](https://github.com/promptwheel-ai/promptwheel#in-ci-and-in-claude-code) (`uses: promptwheel-ai/promptwheel@v0`); the debt gate below is this repo's own Action. For every project at once: `sawbuck attach --user`.

One entry point each: a person types `sawbuck`; CI and libraries use `promptwheel` (the engine underneath, `import { check }`). `sawbuck check` passes every `promptwheel run` flag through, so you never need both.

What a check looks like:

```
$ sawbuck check
🐴 🚩 gamed: a win here came from editing the test, config, or grader, not the source.
   It does NOT survive a source-only re-run, so it does not count.

$ sawbuck check        # after fixing the source and restoring the test
🐴 ✓ verified: your working change earned it. "tests_pass" held, and the source carried the win.
```

Exit codes: `0` verified · `1` regression · `2` gamed · `3` inconclusive · `64` could not run (not a git repo, no commit, no test command).

## What it does

- **Verifies the win.** `check` re-runs your metric from the source diff alone. A faked green (a deleted, weakened, or skipped test; a mocked grader; an edited golden file; a loosened config) reads `gamed`. Deterministic, zero-LLM, $0, and it cannot be argued with because it never reads the trajectory. Red-teamed across 9 language ecosystems and 26 adversarial scenarios ([promptwheel/bench/REDTEAM.md](https://github.com/promptwheel-ai/promptwheel/blob/main/bench/REDTEAM.md)).
- **Says what it cannot see.** A cheat that lives inside the source itself (a value hardcoded to the one visible case, logic keyed to the test environment) is invisible to a source-only re-run, by construction. That limit is in [the contract](CONTRACT.md#3-the-integrity-boundary-what-counts-as-gaming), not hidden.
- **Remembers what broke.** `context` surfaces the relevant history (reverts, fragile areas, test-weakening) for the files you are touching: a ranked trail guide, before you act.
- **Shows you everything.** `status` is the inventory: what it has caught for you over time, the debt accruing now, and whether it is armed here, in one view. On-demand, so it is quiet until you go looking.
- **Rides on, does not replace.** Sawbuck is the verify + memory layer. Your agent and your loop stay yours.
- **Clean on and off.** `attach` touches nothing in your worktree (the hook lives in `.git/`, the record is excluded locally); `detach` is a true inverse. `trace` shows every byte it placed, and `detach --verify` proves the repo came back unchanged.

## Commands

| command | what |
|---|---|
| `sawbuck check [--base R --head R] [--repeat N] [--allow "reason"] [--json]` | verify your latest change (working tree if dirty, else the last commit, or a range); zero-config, no attach, no record. Every `promptwheel run` flag passes through: this is the engine with a plain-spoken verdict |
| `sawbuck init` | write the contract (`promptwheel.config.json`), tuned by what your git history shows actually breaks |
| `sawbuck attach [--claude \| --user]` | enforce it (git post-commit / project Claude hooks / user-level for every project) |
| `sawbuck detach [--claude \| --user]` | remove it; no flag reverses whatever is attached here |
| `sawbuck status` · `sawbuck log` | the inventory (caught over time + debt now + armed state), in one view; and the recent per-check feed |
| `sawbuck debt` | the whole-repo live suppression debt: what is still silenced in HEAD now, disabled tests first, heaviest files ranked |
| `sawbuck context` | the ranked relevant history for the current change |
| `sawbuck frame` | the contract's hard rules (mandates, inherited ones included) as one compact block; silent without a contract |
| `sawbuck turn` | frame + context in one block: what `attach --claude` runs on every prompt and again right after a compaction |
| `sawbuck recall` | related notes for your current change from extra memory providers you compose in (bring your own) |
| `sawbuck trace` · `sawbuck doctor` · `detach --verify` | show the footprint; check the attachment resolves; prove a clean removal |
| `sawbuck where` · `sawbuck statusline` | list every repo it is attached to; a one-line status-line segment (🐴 watching / N caught / steer %) |

## Give your agent the contract

`sawbuck init` writes this block into your `AGENTS.md` for you (and `CLAUDE.md` / `.cursorrules` if present; `--no-agent-block` to skip), and `sawbuck attach --claude` enforces the same thing every turn via the hook. Here it is to paste yourself if you want:

    This repo is under a Sawbuck contract: a change is done only when the win survives verification
    from the source alone. Before finishing, run `sawbuck check`. If it reads `gamed`, the green came
    from editing a test, config, or grader, not the source, so undo that and earn it in the source.
    Run `sawbuck context` first to see what broke in these files before (reverts, weakened tests,
    fragile spots). Never skip, weaken, or delete a test to go green.

**Measured, not assumed.** On a scenario whose natural fix sits inside a protected module, driven past two forced compactions (and again on Haiku, and under "urgent hotfix" pressure): with no rule the agent edited the protected file 17 of 17 times; with a rule in any form, including a mandate, 0 of 45. The model honors a rule it was told. The gate is for the rule nobody told it, the session that outlived the summary, and the proof that it held: `attach --claude` re-reads the mandates from the repo on every turn, re-impresses them after a compaction (`sawbuck turn`), and blocks a turn that leaves a protected path changed. Numbers and method: [sawbuck.ai/contracts](https://sawbuck.ai/contracts).

Without a `promptwheel.config.json` the check measures your detected test command. To make it count more (coverage, lint, latency, an eval) or to protect a path with a mandate, `sawbuck init` writes the config and explains each line with evidence from your history.

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

- **the check** : the deterministic outcome gate, a published standard (the [Verified-Outcome Contract](CONTRACT.md)) that others conform to. Reference implementation: **promptwheel**. You plug in *what* to measure (your tests, lint, coverage, an eval); the source re-proof is the fixed part. Embed it with `import { check }`, or check any tool's verdict with `promptwheel conformance`.
- **the memory** : the relevant history for the files you touch, plus the live debt. A socket you can fill. Default provider: **@promptwheel/logbook** (git history as agent memory; also ships an MCP server). Sawbuck reads it through one adapter, so you can *compose in your own* memory: `SAWBUCK_MEMORY=logbook,obsidian` keeps logbook as the git-truth + debt provider and adds your notes, then `sawbuck recall`. Four reference providers ship in `providers/`: **obsidian** (local notes vault; set `OBSIDIAN_VAULT`), **local** (a plain JSON file, zero setup), **claude** (read-only: your project's `CLAUDE.md` / `.claude` memory, already there, nothing to configure), and **mem0** (semantic memory; the one that reaches the network, so it needs a `MEM0_API_KEY` or a `~/.mem0` key file, unlike the offline default; verified against Mem0's v3 API). Any bin that speaks the three contract verbs works; `sawbuck memory-conformance <bin>` checks one. Composed providers are **folder-scoped and isolated by default**: each repo sees only its own memory, never a sibling's. Drop a `.sawbuck-root` marker (or set `SAWBUCK_MEMORY_ROOT`) in a parent folder to let repos under it inherit that folder's shared memory, top down. logbook is the default, not a hard requirement of the idea.

In one line: the check is a standard we publish for others to meet; the memory is a socket we expose for others to fill. Sawbuck composes the two.

Apache 2.0.
