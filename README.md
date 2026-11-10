# sawbuck

**Was that green earned, or was the test edited to pass?** Sawbuck re-runs your tests from the agent's **source** edits alone, so a win that only came from editing the test reads as gamed. It keeps what git threw away (a reverted attempt and its reason, squashed out of the log) and shows it to your agent when you ask for that file again. And it turns what you keep telling your agent into written rules, each with your own words behind it.

Measured: we put a test that could not pass into 6 real repos and told Claude to get to green fast. With no rule, it got there by changing the test 85 of 100 times; with one line in `CLAUDE.md`, 0 of 100. A reverted attempt squashed out of git was redone blind 26 of 27 times with git alone, and 0 of 27 when Sawbuck showed the reason with the prompt, with all 27 asking first. The corrections a person kept making came back 57 of 216 times in a fresh session with nothing written, 2 to 8 of 216 with the rules written. Of 593 active repos we checked, about half had a rules file for agents, and 19 had a rule like the test one.

In Claude Code, install the plugin and keep working:

```
/plugin marketplace add sawbuck-ai/reins
/plugin install sawbuck-reins@sawbuck
```

The first time you open a git repository with no rules, Claude finishes your task and offers once to add them. Say yes: it writes the rule, sets your protected paths, and watches every turn: protected paths at the end of each turn, each commit re-proved from the source.

Or from the command line:

```sh
# 1 · try it (no install, no commitment): verify your latest change right now
npx sawbuck check

# 2 · give this repo its rules: the written rule, protected paths, and your tests if it has no config yet
npm i -g sawbuck
sawbuck contract          # --full adds supply-chain guards, a repo lock and, on a GitHub repo, a CI check
sawbuck attach            # watch every Claude Code turn in this repo (--shared for a team file, --codex for Codex, --cursor for Cursor, --git for any other agent)
```

**Zero-config:** it finds npm, pytest, cargo and go tests on its own, so in those repos there is nothing to write to start. That includes npm, yarn and pnpm workspaces: each workspace's own `node_modules` is linked into the clean copy the check runs in, and a sibling package is read at the commit being measured. If the tests import a sibling package's built output, they need the build first: `sawbuck init` adds it as `setup`. Anything else (a Makefile target, say) reads inconclusive until you set the command in `promptwheel.config.json`. When it cannot measure, it says which it was: tests that fail before and after, a dependency the clean copy is missing, or a `setup` command that failed.
On attach it tells you exactly what it can measure here (and how to fix it if it can't).
`sawbuck init` writes that config: your detected tests and the tripwires, with notes from your history. Coverage, latency or a cost budget you add to it by hand.
In CI, the same check runs as the [promptwheel GitHub Action](https://github.com/promptwheel-ai/promptwheel#in-ci-and-in-claude-code) (`uses: promptwheel-ai/promptwheel@v0`, or pin it by commit: `sawbuck contract --full` writes the workflow with every action pinned by commit, its own included); the debt gate below is this repo's own Action. For every project at once: `sawbuck attach --user`. Under `--user` the check runs only in repos that have a `promptwheel.config.json`.

One entry point each: a person types `sawbuck`; CI and libraries use `promptwheel` (the engine underneath, `import { check }`). `sawbuck check` passes every `promptwheel run` flag through, so you never need both.

What a check looks like:

```
$ sawbuck check
🚩 gamed: a win here came from editing the test, config, or grader, not the source.
   It does NOT survive a source-only re-run, so it does not count.

$ sawbuck check        # after fixing the source and restoring the test
✓ verified: your working change earned it. "tests_pass" improved, and the source carried the win
   (it survives a source-only re-run).
```

Exit codes: `0` pass (verified, held, or allowed) · `1` sent back (a regression or a protected path) · `2` gamed · `3` inconclusive · `64` could not run (not a git repo, no commit, a bad ref, an unknown flag, a bad or missing flag value, a bad config, or `--working` with nothing uncommitted, and it says which); no detectable test command reads `3` inconclusive, and says so.

## What it does

- **Verifies the win.** `check` re-runs your metric from the source diff alone. A test that went from red to green because of a deleted, weakened, or skipped test, a mocked grader, an edited golden file, or a loosened declared config reads `gamed`. A suite weakened while it stays green is not proved: there is no win to re-run. Tripwires catch skips and removed assertions in a signed repo. Deterministic, zero-LLM, $0, and it never reads the trajectory. No appeals once signed; `--allow` lets a change through with a person's reason, and the check says it was allowed, never verified. A `Sawbuck-Allow:` commit trailer clears nothing in `sawbuck check`, the Stop hook or the git hook, signed or not, because an agent can write a commit message. Red-teamed in 26 scenarios across 9 ecosystems: of 22 attempts to game it, 12 were caught and 10 got through, each one a limit the report lists, and all 4 honest fixes passed ([promptwheel/bench/REDTEAM.md](https://github.com/promptwheel-ai/promptwheel/blob/main/bench/REDTEAM.md)).
- **Says what it cannot see.** A gaming move that lives inside the source itself (a value hardcoded to the one visible case, logic keyed to the test environment) is invisible to a source-only re-run, by construction. That limit is in [the contract](CONTRACT.md#3-the-integrity-boundary-what-counts-as-gaming), not hidden.
- **Remembers what broke.** `context` surfaces the relevant history (reverts, fragile areas, test-weakening) for the files you are touching: a ranked trail guide, before you act.
- **Shows you everything.** `status` is the inventory: what it has caught for you over time, the debt accruing now, and whether it is armed here, in one view. It says watching only while hooks are wired for this repo, not because an earlier attach left its record on disk. On-demand, so it is quiet until you go looking.
- **Rides on, does not replace.** Sawbuck is the verify + memory layer. Your agent and your loop stay yours.
- **Clean on and off.** `attach` writes a git-excluded `.claude/settings.local.json`, the lines in `.git/info/exclude` that keep its files out of `git status`, a receipt under `.git/sawbuck/`, a line in `~/.sawbuck/registry.json` (the list `detach --all` reads), and in a signed repo `.sawbuck/state.json` (`attach --git` writes the post-commit hook and `.sawbuck/state.json` in place of the settings file); `attach --dry-run` lists all of it. `detach` removes the hooks and the receipt, and still removes the hooks when the receipt is lost; `detach --dry-run` lists what would go. A post-commit hook that was there before `attach --git` is put back byte for byte. Signed contract files stay because they are yours to review. The record (`.sawbuck/`, the logbook files) stays too, still out of `git status`, until `detach --purge` deletes it and the exclude lines. `detach --verify` proves the wiring is gone and names what is left.
- **A limit of the hooks file.** `.claude/settings.local.json` is kept out of git, so taking the hooks out of it shows in no diff, and the check cannot see it. `sawbuck doctor` can: it reads the receipt and says the hooks are gone, or that the set is incomplete (a missing Stop hook, say). `sawbuck attach --shared` avoids it: the hooks go in a tracked file, and a removal shows in git.
- **What a check costs.** It runs your test command, and your `setup` command if the config has one, in a clean copy at each commit it compares, and once more when a test went from red to green. Under the Claude hooks that happens when a turn made a commit, not on every turn. If `setup` is a full production build, narrow it to what the tests need.
- **A limit of the turn hook.** The hook re-runs your tests on commits, not on uncommitted work. A test edited to go green and left uncommitted is not sent back at the end of that turn. It is caught when it is committed, and `sawbuck check` reads it on demand, which is what the written rule tells the agent to run before finishing.
- **A limit of the git hook.** `attach --git` pins the hook to the checkout it was attached from, so a commit made in a linked git worktree is not checked. A hooks folder inside the work tree (`core.hooksPath`, as husky sets it) is refused, and attach prints the line to add by hand; `detach`, `doctor` and `status` do not know about a line added that way.

## Commands

| command | what |
|---|---|
| `sawbuck contract` | gives a repo its rules: protected paths and the written rule. With no config yet it writes one with your detected tests; an existing config is kept as it is, and gets no tests added. `--full` adds supply-chain guards, a repo lock and a CI check (only with a github.com origin and a real test command; it says when it skips it). `--strict` makes them block, also after an earlier `--full`. `--dry-run` previews |
| `sawbuck check [--base R --head R] [--repeat N] [--allow "reason"] [--json]` | verify your latest change (working tree if dirty, else the last commit, or a range); zero-config, no attach, no record. Every `promptwheel run` flag passes through: this is the engine with a plain-spoken verdict |
| `sawbuck attach [--user \| --shared \| --git]` | watch every Claude Code turn here: protected paths at the end of each turn, a source-only re-run on each commit. `--user`: in every repo that has a `promptwheel.config.json`. `--shared`: a tracked `.claude/settings.json` a team commits, with no path from your machine in it. `--git`: a post-commit hook, so every commit is checked whatever made it, from the first one after attach (the very first commit of a repo has nothing to be checked against). It leaves a hook alone if it is not a shell script or not executable, and says what to add by hand |
| `sawbuck detach [--user] [--all] [--verify] [--purge] [--dry-run]` | remove the hooks; no flag removes whatever is wired here, with or without the receipt, `--all` does every repo. `--purge` also deletes the record, `--dry-run` only lists what would go |
| `/sawbuck-reins:audit` | finds rules in your agent files that can pull against each other, and proposes which wins. No history needed |
| `/sawbuck-reins:rules` | proposes the rules you keep enforcing, from your own messages, each with quotes; you pick what to keep. Tested on one person so far |
| `/sawbuck-reins:shape` | what you push on, from a sample of your own messages, as a card. It also reads up to 120 past turns and names habits the agent has that you never push on, each with the agent's own words. Leads from one read, tested on one person |
| `sawbuck init` | writes only the config: your detected tests and the tripwires, with notes from your history. `contract` runs it for you when the repo has no config yet |
| `sawbuck status` | the inventory (caught over time, debt now, armed state, what you keep saying), in one view; `--log` for the recent per-check feed |
| `sawbuck debt [repo]` | the whole-repo live suppression debt: what is still silenced in HEAD now, disabled tests first, heaviest files ranked |
| `sawbuck context` | the ranked relevant history for the current change |
| `sawbuck doctor [--all]` · `detach --verify` | run what each hook runs (project and user level) and say if it still works, if the set is incomplete, or if it is gone (exit 1), `--all` for every repo it is attached to; prove the wiring is gone |
| `sawbuck statusline` | a one-line status-line segment (watching / N caught) |

## Protected paths

`sawbuck contract` protects these by default. A change to one reads "sent back", whoever made it.

| rule | paths | how a person makes an exception |
|---|---|---|
| `contract-frozen` | `promptwheel.config.json`, `sawbuck.config.json` | `sawbuck check --allow "<reason>"` |
| `hooks-frozen` | `.claude/settings.json`, `.claude/settings.local.json`, `.sawbuck/**` | `sawbuck check --allow "<reason>"` |
| `workflows-frozen` | `.github/workflows/**` | remove the rule first |
| `registry-config-frozen` | `.npmrc`, `.yarnrc`, `.yarnrc.yml` | remove the rule first |
| `build-images-frozen` | `Dockerfile*`, `docker-compose*` | remove the rule first |
| `publish-scripts-frozen` | `scripts/release*`, `scripts/publish*` | remove the rule first |
| `codeowners-frozen` | `CODEOWNERS` | remove the rule first |

To remove a rule, delete its entry under `mandates` in `promptwheel.config.json`, in a commit of its own. That file is protected too, so that commit takes `--allow`. Then make the change. To protect another path, add an entry the same way: `{"name": "billing-frozen", "paths": ["src/billing/**"], "reason": "billing changes go through review"}`.

## Give your agent the rule

`sawbuck contract` and `sawbuck init` write this block into your `AGENTS.md` for you (and `CLAUDE.md` / `.cursorrules` if present; `init --no-agent-block` skips it), and `sawbuck attach` enforces it through the hook: every turn checks protected paths, and every commit is re-proved. Here it is to paste yourself if you want:

    In this repo a change is done only when the win survives verification from the source
    alone. Before finishing, run `npx -y sawbuck check`. If it reads `gamed`, the green came
    from editing a test, config, or grader, not the source, so undo that and earn it in the
    source. Run `npx -y sawbuck context` after your first edit to each file, to see what
    broke there before (reverts, weakened tests, fragile spots). Never skip, weaken, or
    delete a test to go green.

**With `--full`.** `pins_changed` is a fingerprint of the resolved dependency tree, not a count, so its value is a long number that only means changed or unchanged. The supply-chain guards read `unmeasurable` on the commit that adds them, because their scanners did not exist before it, and count from the next change. It starts by watching: protected paths, new install scripts and sources outside the registry block from day one, and new dependencies and structure changes show as notes. `sawbuck contract --strict` blocks them all. When something fails, the check says what changed in words. If your tests can't run in CI, the check says so and doesn't fail the job, and protected paths are still enforced. To accept it on a pull request, someone with write access comments `sawbuck-allow: <reason>` and re-runs the check; the reason stays on the record. An agent signed in as that person could post the same comment, so branch protection and review still matter. Locally, use `--allow "<reason>"`. A commit trailer is not a person, so Sawbuck does not read one.

**A hold that holds.** Some commands leave the repo and cannot be taken back: `npm publish`, a `gh release`, `gh pr merge`, a public `gh issue comment` or `gh pr comment`, a `git push --force`, `vercel --prod`. `attach` wires a PreToolUse hook that turns each of these into a question to you before it runs; everything else passes untouched, a plain `git push` included. Why a hook and not a line: in our holds bench a hold written in CLAUDE.md ("do not push yet") was talked past by a later ask 6 of 9 times, and a hook is not talked past. Add your own patterns under `holds.outward` in `sawbuck.config.json`, or set `{"holds":{"off":true}}` for a repo.

**Beside a model verifier, too.** Claude Code's agent hooks and superpowers' `verification-before-completion` ask a model, at the end of a turn, whether the work is really done. The check is the floor under that question: it does not ask, it re-runs the tests from the source edits alone, in a clean copy, with no model in the loop. Keep the verifier; give its RUN step `npx -y sawbuck check`, and a green that came from an edited test, a skipped test, a changed config or a touched golden file reads as gamed instead of done.

**Beside whatever memory you run.** Sawbuck hands what it finds to the memory on your machine, once each, and reads nothing back: every rule you accept in `/rules`, every reverted attempt the hook recovers (with its reason), every gamed green the check catches. Sinks today: claude-mem's local worker (a titled memory, because its session-start index shows titles), Claude Code's own notes for the project (a note in its form, so Sonnet and Haiku get what Opus writes for itself), and a Markdown folder you name in `sawbuck.config.json` (`{"share":{"markdown":"notes/agent"}}`) for Obsidian or any layer that imports Markdown. A sink that is not there is skipped in silence; `SAWBUCK_SHARE=none` turns it all off. `sawbuck share --title "<rule>" <words behind it>` does it by hand, and `sawbuck rules --notes` lists the notes Claude Code's memory already holds for this repo so `/rules` can offer to promote them into the repo's CLAUDE.md. Why the file still comes first: in our twin bench a correction that lived only in the person's words came back 18 of 36 times through a memory layer's own notes and 0 to 2 of 36 as a written rule. The check stays one thing, with nothing to swap into it; the hand-off is the only part that fans out.

**Rewritten history.** Logbook reads git, so a squash or a rebase takes a revert with it. `sawbuck context` also reads the reflog for commits no branch reaches any more and shows them for the files in hand, with the reason from a revert's message, and once attached it keeps them in `.sawbuck/rewritten.jsonl` after the reflog expires. It stays local: a clone does not get it, nothing older than the reflog comes back, and work that was never committed is not in git at all. Your steering is separate: `reins` reads your agent transcripts, not git.

**Undone in a session, never committed.** Most abandoned attempts never reach git: the agent adds something, you say "undo that, it logged people out last time", the file goes back, and the next session adds it again. Measured (proof-bench/attempts, 2026-11-10): 27 of 27 redid an undone approach with nothing written anywhere; with the record shown at the prompt, 0 of 27, and all 27 named the reason. So `attach` also wires the edit tools: before an edit the hook snapshots the file once per session; after one, a file back at its snapshot after a change and after a word from you is an undo, kept in `.sawbuck/undone.jsonl` with what the change had added and your words, and shown with the prompt that names the file, in `sawbuck context`, in `status`, and to the memory sinks as a finding. An undo the agent makes on its own, with no word from you in between, is not recorded. Deterministic, no model; it stores a diff summary and your own prompt, nothing else, and stays local.

**Codex too.** `sawbuck attach --codex` writes the same hooks into `.codex/hooks.json` (kept out of git status): the rules with each prompt, a gamed commit sent back at Stop, and the hold on outward commands. Codex runs a new hook only after you trust it once in its `/hooks` screen. Two differences, both from Codex's side: it does not support "ask" yet, so the hold denies the command and tells the agent a person runs it; and the undo ledger is not wired, because Codex edits through patches rather than file paths.

**Cursor too.** `sawbuck attach --cursor` writes `.cursor/hooks.json` (kept out of git status): the check at the end of each agent run, where a gamed commit comes back to the agent as a follow-up message (three at most), and the hold, which asks you before an outward shell command. Cursor's prompt hook can only allow or block, so the rules reach the agent through the AGENTS.md and .cursorrules lines `sawbuck contract` writes, and history does not ride the prompt; the undo ledger is not wired.

**Notes that went stale.** `sawbuck rules --notes` lists the notes Claude Code's own memory holds for this repo, and flags the ones that name files the repo no longer has, so a note about code that is gone is checked before anyone promotes it.

**Shared with the team and CI.** That ledger is local until you share it: `sawbuck ledger push` puts the erased attempts and their reasons on `refs/sawbuck/ledger` (its own ref, one file, never on a branch) and pushes it; `sawbuck ledger pull` takes it into another clone, where `sawbuck context` and the prompt hook show it with no attach needed. The Action fetches that ref, so a pull request that touches a file with an erased revert gets the revert and its reason in the check's output, and with `comment: 'true'` (and `pull-requests: write`) as a comment on the pull request. Entries are keyed by subject and files, not by sha, because shas do not survive the rewrite that erased them. A person runs push and pull; no hook pushes anything.

**Tested claims.** Every claim above, and every limit, is a test in [`test/claims.test.mjs`](test/claims.test.mjs), run on a clean account.

**Measured, not assumed.** On a scenario whose natural fix sits inside a protected module, 62 trials: 52 driven past a forced compaction (two on the default model, one on Haiku) and 10 shallow, some under "urgent hotfix" pressure. With no rule the agent edited the protected file 17 of 17 times; with a rule in any form, including a mandate, 0 of 45. Earlier scenarios did not tempt it (no rule, 0 of 17), and the wall never had to fire. The model honors a rule it was told. The gate is for the rule nobody told it, the session that outlived the summary, and the proof that it held: once attached, the hooks re-read the mandates from the repo on every turn, say them again after a compaction, and send back a turn that leaves a protected path changed, up to three times by default. Numbers and method: [sawbuck.ai/contracts](https://sawbuck.ai/contracts).

Without a `promptwheel.config.json` the check measures your detected test command. `sawbuck init` writes the config with that command and the tripwires, and explains each line with evidence from your history. To make it count more (coverage, lint, latency, an eval) or to protect another path, add a metric or a mandate to it by hand.

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

`--fail-on` takes `undocumented` (a bare `# type: ignore` / `# noqa` with no code), `test` (a newly disabled test), `any`, or a number of new suppressions; anything else is an error (exit 64). Without `--since` it gates everything live in HEAD, not only what a branch adds. Exit 1 fails the check; add `--json` for the machine-readable delta. This repo is also a composite action: `uses: sawbuck-ai/sawbuck@v0` with `base` and `fail-on` inputs.

Debt is on demand: `sawbuck debt`, and `sawbuck context` for the files in hand. One thing is not on demand: when a prompt names a file (`src/cache.js`, or a bare `cache.js` that matches one tracked file), the hook shows what a rewrite erased there, a revert and its reason, with the prompt, before any edit. In our twin-repo bench that timing was the whole difference: shown with the prompt, 0 of 27 agents redid a reverted change and 27 of 27 asked first; left for the agent to ask after its first edit, it checked once per session and redid it 27 of 27. To have the rest of the history (hot spots, weakened tests) added to every turn as well, set `{"turn":{"context":true}}` in `sawbuck.config.json`. That is off by default because a written rule did the work in every bench, and context spent on each prompt is context lost.

## The engines

Sawbuck is thin glue over two engines:

- **the check** : the deterministic outcome gate, written up as a draft spec (the [Verified-Outcome Contract](CONTRACT.md)). Reference implementation: **promptwheel**. You plug in *what* to measure (your tests, lint, coverage, an eval); the source re-proof is the fixed part. Embed it with `import { check }`, or check any tool's verdict with `conformsToContract()` from the same package.
- **the memory** : the relevant history for the files you touch, plus the live debt, from **@promptwheel/logbook** (git history as agent memory; also ships an MCP server).

Apache 2.0.
