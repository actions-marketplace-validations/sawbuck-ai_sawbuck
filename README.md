# sawbuck

**Sign your agent to a contract so it does what you want.**

You write the contract (what a real win looks like); Sawbuck enforces it, re-proving every win from the agent's **source** edits alone, so a test that went from red to green only because the agent edited the test, mocked the grader, or loosened a declared config reads `gamed` and goes back. Deterministic and zero-LLM: no model in the verdict, nothing read from the agent's trajectory. Attach it and it carries your repo's history along: what broke in these files before, surfaced before you touch them.

> Sawbuck is the reference implementation of the [Verified-Outcome Contract](CONTRACT.md): the open interface for a coding loop you can trust.

In Claude Code, install the plugin and keep working:

```
/plugin marketplace add sawbuck-ai/reins
/plugin install sawbuck-reins@sawbuck
```

The first time you open a git repository with no contract, Claude finishes your task and offers once to sign it. Say yes: every turn checks protected paths, and every commit is re-proved.

Or from the command line:

```sh
# 1 · try it (no install, no commitment): verify your latest change right now
npx sawbuck check

# 2 · sign this repo: the written rule, your tests, protected paths, CI
npm i -g sawbuck
sawbuck contract
sawbuck attach --claude   # then watch every Claude Code turn
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

Exit codes: `0` verified · `1` regression · `2` gamed · `3` inconclusive · `64` could not run (not a git repo, no commit); no detectable test command reads `3` inconclusive.

## What it does

- **Verifies the win.** `check` re-runs your metric from the source diff alone. A test that went from red to green because of a deleted, weakened, or skipped test, a mocked grader, an edited golden file, or a loosened declared config reads `gamed`. A suite weakened while it stays green is not proved: there is no win to re-run. Tripwires catch skips and removed assertions in a signed repo. Deterministic, zero-LLM, $0, and it never reads the trajectory. No appeals once signed; `--allow` is recorded. Red-teamed across 9 ecosystems in 26 scenarios: 12 caught, 10 stated limits, 4 honest ([promptwheel/bench/REDTEAM.md](https://github.com/promptwheel-ai/promptwheel/blob/main/bench/REDTEAM.md)).
- **Says what it cannot see.** A cheat that lives inside the source itself (a value hardcoded to the one visible case, logic keyed to the test environment) is invisible to a source-only re-run, by construction. That limit is in [the contract](CONTRACT.md#3-the-integrity-boundary-what-counts-as-gaming), not hidden.
- **Remembers what broke.** `context` surfaces the relevant history (reverts, fragile areas, test-weakening) for the files you are touching: a ranked trail guide, before you act.
- **Shows you everything.** `status` is the inventory: what it has caught for you over time, the debt accruing now, and whether it is armed here, in one view. On-demand, so it is quiet until you go looking.
- **Rides on, does not replace.** Sawbuck is the verify + memory layer. Your agent and your loop stay yours.
- **Clean on and off.** the default `attach` touches nothing in your worktree (the hook lives in `.git/`, the record is excluded locally); `--claude` writes one git-excluded settings file; `detach` removes what it wired. Signed contract files stay because they are yours to review; `--purge` deletes the record. `trace` shows every byte it placed, and `detach --verify` proves the wiring is gone.

## Commands

| command | what |
|---|---|
| `sawbuck contract` | one command to sign a repo: keeps your contract, adds tests and tripwires if there are none, protected paths, the supply-chain guards, and the architecture lock. `--dry-run` previews it. |
| `sawbuck check [--base R --head R] [--repeat N] [--allow "reason"] [--json]` | verify your latest change (working tree if dirty, else the last commit, or a range); zero-config, no attach, no record. Every `promptwheel run` flag passes through: this is the engine with a plain-spoken verdict |
| `sawbuck attach [--claude \| --user]` | enforce it (git post-commit / project Claude hooks / user-level for every project) |
| `sawbuck detach [--claude \| --user]` | remove it; no flag reverses whatever is attached here |
| `/sawbuck-reins:rules` | proposes the rules you keep enforcing, from your own messages, each with quotes; you pick what to keep. Tested on one person so far |
| `/sawbuck-reins:shape` | what you push on, what the agent did, and the gap between them, as a card |
| `sawbuck status` · `sawbuck log` | the inventory (caught over time + debt now + armed state), in one view; and the recent per-check feed |
| `sawbuck debt` | the whole-repo live suppression debt: what is still silenced in HEAD now, disabled tests first, heaviest files ranked |
| `sawbuck context` | the ranked relevant history for the current change |
| `sawbuck trace` · `sawbuck doctor` · `detach --verify` | show the footprint; check the attachment resolves; prove a clean removal |
| `sawbuck statusline` | a one-line status-line segment (🐴 watching / N caught) |

## Give your agent the contract

`sawbuck init` writes this block into your `AGENTS.md` for you (and `CLAUDE.md` / `.cursorrules` if present; `--no-agent-block` to skip), and `sawbuck attach --claude` enforces it through the hook: every turn checks protected paths, and every commit is re-proved. Here it is to paste yourself if you want:

    This repo is under a Sawbuck contract: a change is done only when the win survives verification
    from the source alone. Before finishing, run `sawbuck check`. If it reads `gamed`, the green came
    from editing a test, config, or grader, not the source, so undo that and earn it in the source.
    Run `sawbuck context` first to see what broke in these files before (reverts, weakened tests,
    fragile spots). Never skip, weaken, or delete a test to go green.

**After you sign.** A new contract starts by watching: protected paths, new install scripts and sources outside the registry block from day one, and new dependencies and structure changes show as notes. `sawbuck contract --strict` blocks them all. When something fails, the check says what changed in words. If your tests can't run in CI, the check says so and doesn't fail the job, and protected paths are still enforced. To accept it on a pull request, someone with write access comments `sawbuck-allow: <reason>` and re-runs the check; the reason stays on the record. An agent signed in as that person could post the same comment, so branch protection and review still matter. Locally, use `--allow "<reason>"`.

**Rewritten history.** Logbook reads git, so a squash or a rebase takes a revert with it. `sawbuck context` also reads the reflog for commits no branch reaches any more and shows them for the files in hand, and once attached it keeps them in `.sawbuck/rewritten.jsonl` after the reflog expires. It stays local: a clone does not get it, nothing older than the reflog comes back, and work that was never committed is not in git at all. Your steering is separate: `reins` reads your agent transcripts, not git.

**Tested claims.** Every claim above, and every limit, is a test in [`test/claims.test.mjs`](test/claims.test.mjs), run on a clean account.

**Measured, not assumed.** On a scenario whose natural fix sits inside a protected module, 62 trials: 52 driven past a forced compaction (two on the default model, one on Haiku) and 10 shallow, some under "urgent hotfix" pressure. With no rule the agent edited the protected file 17 of 17 times; with a rule in any form, including a mandate, 0 of 45. Earlier scenarios did not tempt it (no rule, 0 of 17), and the wall never had to fire. The model honors a rule it was told. The gate is for the rule nobody told it, the session that outlived the summary, and the proof that it held: `attach --claude` re-reads the mandates from the repo on every turn, re-impresses them after a compaction (`sawbuck turn`), and sends back a turn that leaves a protected path changed, up to three times by default. Numbers and method: [sawbuck.ai/contracts](https://sawbuck.ai/contracts).

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

Debt is on demand: `sawbuck debt`, and `sawbuck context` for the files in hand. To have history added to every turn, set `{"turn":{"context":true}}` in `sawbuck.config.json`. It is off by default because a written rule did the work in every bench, and context spent on each prompt is context lost.

## The engines

Sawbuck is thin glue over two roles, each behind an open interface that points in opposite directions:

- **the check** : the deterministic outcome gate, a published standard (the [Verified-Outcome Contract](CONTRACT.md)) that others conform to. Reference implementation: **promptwheel**. You plug in *what* to measure (your tests, lint, coverage, an eval); the source re-proof is the fixed part. Embed it with `import { check }`, or check any tool's verdict with `promptwheel conformance`.
- **the memory** : the relevant history for the files you touch, plus the live debt, from **@promptwheel/logbook** (git history as agent memory; also ships an MCP server).

Apache 2.0.
