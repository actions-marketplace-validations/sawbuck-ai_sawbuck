# The Verified-Outcome Contract

*Put your coding agent under contract: a win counts only if it survives verification from the source alone, not because the agent said so. The terms below are not a promise the agent makes, they are a result anyone can re-prove.*

**Status:** Draft v0.1 · **License:** Apache-2.0 · **Reference implementation:** [Sawbuck](https://github.com/sawbuck-ai/sawbuck) (the CLI), [promptwheel](https://github.com/promptwheel-ai/promptwheel) (the check), [@promptwheel/logbook](https://github.com/promptwheel-ai/logbook) (the default memory provider)

This is an open interface for making an AI coding harness trustworthy. It defines how a loop's wins get verified, what a verdict looks like, what counts as gaming the goalposts, and how a repo's history is carried along. Any harness can emit or consume it without using this code. Sawbuck is a reference implementation; it is not the only possible one.

The contract has one property that holds all of it together: a verdict is **deterministic and reproducible from `(base, head, config)` alone**. No LLM is in the path, and nothing is read from the agent's trajectory, so the result cannot be obfuscated against and does not change when you ask it twice.

A corollary worth stating as an invariant: **the gate is defined only by in-repo, versioned config.** External systems (a dashboard, an issue tracker, a memory provider) may *report on* a verdict, but they must never *define* the guardrail. A guardrail that lives outside the repo is one the check cannot see in the diff, so it cannot be fingerprinted, so loosening it leaves no trace to catch as gamed. Memory (the input) is a pluggable socket; the gate (the output) stays in-repo and fingerprinted.

> This contract covers the check. Sawbuck pairs it with the other half, **memory** (the relevant history for what you touch, plus the live debt), as the mirror idea: where the check is a standard others *conform to*, memory is a socket others *fill*. The default memory provider is @promptwheel/logbook, carried along so it works out of the box, but it is swappable; logbook is a default, not a requirement of the idea.
>
> Both halves nest with your folders, so policy and memory flow top-down and isolate across siblings. A parent `promptwheel.config.json` passes its guardrails down via `extends` (repos inherit the base gate; local metrics override by name), and memory inherits a parent folder's shared scope the same way (a repo sees itself and its ancestors, never a sibling). One model for both: the directory tree is the scope.

---

## 1. The reward contract (exit codes)

The per-turn signal a loop consumes. The check (`run`) exits:

| Exit | Verdict | Meaning | A conforming loop should |
|------|---------|---------|--------------------------|
| `0` | `pass` | The win is real: it survived a source-only re-proof and no guard regressed. | Keep the change. |
| `1` | `fail` | A guarded metric regressed beyond the measured noise band. | Revert. |
| `2` | `gamed` | A metric improved only by editing the goalposts (test, grader, golden, config), not the source. | Revert and flag. |
| `3` | `inconclusive` | Nothing could be certified: a guard never ran (inert) and no metric was measured to improve, or a win's source-only re-run could not be applied, so the win could not be re-proved either way. | Do not trust the green; do not keep on this signal alone. |

The agent consumes this as a per-turn reward it cannot inflate. The harness consumes the same exit as a merge gate the agent cannot self-clear.

## 2. The verdict schema (the audit artifact)

`run --json` emits a report reproducible from `(base, head, config)` alone:

```json
{
  "base": "a1b2c3d",
  "head": "e4f5g6h",
  "mode": "refs",
  "repeat": 3,
  "verdict": "gamed",
  "metrics": [
    {
      "name": "tests_pass",
      "direction": "pass",
      "guard": true,
      "before": 0,
      "after": 1,
      "delta": 1,
      "status": "improved",
      "ok": true,
      "confidence": "high",
      "noise": 0,
      "gamed": true,
      "sourceOnly": null,
      "retained": 0.0,
      "gamingReason": "the win changed zero production-source files, only test/config/grader/golden"
    }
  ]
}
```

Fixed vocabularies (a conforming implementation uses exactly these):

- `verdict` ∈ `pass | fail | gamed | inconclusive`
- `metric.status` ∈ `improved | regressed | unchanged | inconclusive | unmeasurable`
- `direction` ∈ `up | down | pass` (the direction that counts as better; `pass` means a 0/1 gate)

`retained` is the fraction of a metric's gain that survived the source-only re-run (§3). `noise` is the measured jitter band as a single number, across the top-level `repeat` runs; a delta inside it leaves that metric `inconclusive` (neither a win nor a regression; the verdict is not failed by it). `confidence` (`none | unverified | low | medium | high`, `none` for an unmeasurable metric) and `sourceOnly` (the metric's value when only source edits are replayed, §3) are informational fields the reference implementation adds; a minimal conforming report may omit them. A consumer validates a report with `conformsToContract()` from the `promptwheel` package (see INTEGRATE.md) or `promptwheel conformance`.

`gate` (optional) is the gate-integrity record. `gate.fingerprint` is a truncated SHA-256 of the normalized gate definition at `base` and `head`, so a changed gate is visible in the audit record. `gate.weakened`, present only when it happened, lists guards the change dropped (removed, or set to `guard:false`) that would have failed at `head`. A non-empty `gate.weakened` forces `verdict: gamed`: an agent cannot earn a pass by disabling the guard it is being judged by.

## 3. The integrity boundary (what counts as gaming)

This is the part that makes "moving the goalposts" objective rather than a judgment call.

A win is **`gamed`** when it does not survive a **source-only re-run**: revert every non-source change the agent made, re-measure, and see how much of the gain remains (`retained`). If `retained` falls below `gamingThreshold` (default `0.5`), the verdict is `gamed`.

- **Non-source** (reverted before the re-run): tests, specs, fixtures, snapshots and golden files, graders, config, plus any path declared in `evaluatorPaths`.
- **Source**: everything else, the code the change was supposed to be about.
- **`evaluatorPaths`**: an opt-in allowlist a repo declares for its own gate files (a threshold file, a budget, a ruleset), because a generic name is a classifier risk and only the repo owner knows which files are the goalposts.

**Honest boundary, stated not hidden:** a cheat that lives *inside the source itself* (code that behaves correctly only while a test is watching) is invisible to a source-only re-run, by construction. The contract catches every out-of-source goalpost move; it does not claim to catch a source-resident backdoor. That needs held-out or behavioral analysis, which is a different layer.

**Protected terms (declared, optionally enforced).** `evaluatorPaths` is also the declaration surface for immutability: the files a repo names there are its fixed terms, the goalposts the agent does not get to move. The baseline is detection (a win that depended on changing a protected term reads `gamed`). A stronger conformance level *enforces* it: the audit gate (CI, or a hook the agent cannot bypass) fails any change to a protected term unless a human signs off, so the terms cannot be moved mid-game. Note the honest limit: a file cannot be made truly immutable to an agent that has write access to the repo. The guarantee comes from the un-bypassable gate, not from the filesystem.

**Declared override (an intentional test change).** The check flags a win that came only from moving the goalposts, not from the source. Sometimes that move is legitimate: a test that asserted the wrong thing, an obsolete test removed, a guard intentionally retired. The sanctioned way through is to DECLARE it, not to silently weaken the gate. A `Sawbuck-Allow: <reason>` trailer on the commit (`Promptwheel-Allow:` is the same thing; or `--allow "<reason>"` for a working-tree or CI run) acknowledges the change, so a would-be `gamed` reads `pass` with the acknowledgment recorded in `allowed` (the reason, and the metric or gate names it cleared). The check does not judge intent; it forces intent to be explicit and auditable. An UNdeclared test-only win is still `gamed`; a declared one is on the record, so a reviewer sees the reason instead of a silent green. It covers the edit, the delete, and the new file alike. The declaration lives in the commit, so it is immutable and attributable: revoking it is a review act, not a deletion, and a reasonless trailer does not override.

## 4. The context record (the trail knowledge)

A conforming implementation also carries the repo's history as deterministic memory: a ledger derived from git (hotspots, reverted approaches, suppressed or weakened tests, fragile areas), surfaced per turn as a ranked slice for the files being touched. It is a projection of git, never a second source of truth, so it is always reconstructable and never drifts from what actually happened.

---

## Conformance

- A conforming **check** emits §2 and the §1 exit contract, computed deterministically, with no LLM and nothing read from the agent's trajectory.
- A conforming **loop** consumes the §1 exit code as its per-turn reward.
- A conforming **harness** runs the check as the audit gate (so the agent cannot self-clear its own win).
- A conforming **context record** is a deterministic projection of git (§4).

An implementation may support a subset and say so. The reference implementation (Sawbuck) implements all four.

## Versioning

This contract is versioned with semver. `v0.1` is a draft: the vocabularies in §1 and §2 are stable, the exact field set in §2 may still grow (additively) before `v1.0`.
