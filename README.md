# optimize-skill

**A profile-guided compiler for AI agent skills.** `/optimize-skill <target>` takes an agent
skill, mines how it's actually been used from your local agent history, works out which of its steps
genuinely need a frontier model, and compiles the rest into a small, inspectable helper - while
never touching human gates, side-effect ordering, or genuinely generative work.

It compiles each operation to the cheapest reliable primitive:

| Class | Compiles to | Example |
| --- | --- | --- |
| Deterministic (parsing, fixed maps, validators, limits) | **code** | read config, derive a value, a type→label map, a lint check |
| Bounded semantic (classify / yes-no / score / route) | **[Jev](https://openrouter.ai/typesafe)** - a typed-decision model with calibrated confidence | commit type, priority bucket, "enough context?" |
| Generative (writing, novel synthesis) | **agent** (kept) | drafting a PR summary or issue description |
| Research / exploration | **agent + tools** (kept) | investigating a codebase |
| External effect (create/update/submit) | **existing MCP/tool** (kept, after its gate) | `gh pr create`, a Linear MCP call |
| Human gate (approval, assignment) | **user** (kept) | "commit with this message?", pre-create review |

Every bounded decision carries a calibrated confidence; below threshold, the skill **deoptimizes**
- it falls back to the original agent path for that decision. The original `SKILL.md` is always
preserved as `SKILL.original.md`, so any optimization is one `cp` away from reverting.

## Results

Four real skills were optimized end-to-end against real usage history. The spread is the point -
the optimizer compiles heavily where it helps and refuses (or falls back) where it doesn't.

| Skill | Real runs | Compiled to | Jev nodes | Decision-quality eval (measured)¹ | Cost/run: before → after² |
| --- | --- | --- | --- | --- | --- |
| **commit** | ~100 | code + Jev | 3 | type **79.8% raw / 89.2% among acted** (22.6% defer); 83-case e2e **81.9 / 89.8** | **$2.41 → $0.70–1.32** (−45 to −71%) |
| **open-pr** | 11 | **code only** | 0 | **20/20** e2e (git counts matched raw `git` exactly) | **$2.29 → $0.66–1.26** (−45 to −71%) |
| **module-docs** | 12 | **code only** (2 helpers) | 0 | Arm A **5/5 correct deopt** (no harm); Arm B discovery recall **62%** (100% on clean module names) | **$2.99 → $0.88–1.62** (−46 to −70%) |
| **create-linear-issue** | 0 (static)³ | code + Jev | 5 | issue type **6/6**, priority **1/1** on a labeled set | n/a (no history) |

¹ **Measured** - the real helper run against **reconstructed real state** (e.g. a detached worktree at
each historical commit's parent), not a shortcut that bypasses the helper. Agreement is vs. the
historical agent/user - a **baseline, not an oracle**; most "disagreements" are genuinely subjective
boundaries (`feat`↔`refactor`) the human gate catches anyway.

² **"before" is measured, "after" is modeled.** The *before* is real - billed tokens across every
recorded run × published rates (token counts exact; dollars just make it legible, since these run on
monthly plans). ~15 mid-session turns/run, **~98% of tokens are cache read/write** from re-reading
the cached conversation each turn. The *after* range comes from modeling the gathering loop collapsing
from ~15 turns to 8 / 6 / 4 (conservative → optimistic), which cuts that cache-read traffic roughly in
proportion. It's a projection from one turn-count assumption - **not yet measured** by running the
optimized skills at scale (the ranges land similar across skills because it's the same assumption).

³ No structurally-mineable history existed for this skill on disk, so it was optimized static-first.

## Requirements

- [Bun](https://bun.sh) - helpers and scripts are TypeScript run via `bun`.
- **Jev access** (only for skills with bounded-semantic decisions). Provide credentials as
  `{ "provider": "openrouter" | "typesafe", "key": "…", "model"?: "…" }` at
  `~/.config/optimize-skill/jev.json`, or via `OPENROUTER_API_KEY` / `TYPESAFE_API_KEY`. If none is
  found, the skill asks. Never commit the key.

## Usage

Invoke it as a slash command on a target skill in the current project:

```
/optimize-skill <skill-name>
```

The optimizer reads the whole target skill and how it's really used, mines your local agent history
(Claude Code + Codex), classifies every operation, generates the helper(s), builds an end-to-end
eval, rewrites the skill around the helper, and emits a manifest + report - or a "not worthwhile"
report when the expected value is low.

Handy scripts (also run directly):

```bash
bun run creds                                  # show resolved Jev provider (key redacted)
bun run jev:probe                              # one live Choice/Noul/Score call
bun run traces:find -- <skill>                 # honest listing-vs-invocation-vs-run counts
bun run cost -- <skill>                         # measured before-tokens + modeled after
```

## What it produces

Per optimized skill (under `output/<skill>/`, and installed into the skill's own dir):

- `<helper>.ts` - one helper per contiguous compilable segment (often just one).
- `SKILL.md` - the optimized skill (harnesses load this); `SKILL.original.md` - the original, verbatim.
- `manifest.json` - machine-readable record of what was compiled / preserved / the fallback policy.
- `report.md` - honest evaluation: agreement, fallback rate, the token-usage analytics breakdown
  (measured before / modeled after), edge-case coverage, and a human-gate preservation checklist.

## Layout

```
.claude/skills/optimize-skill/
  SKILL.md            # the optimizer procedure
  scripts/            # jev-client, credential resolver, trace miner, run extractor, split, eval, cost
  references/         # operation-class model, Jev design rules, manifest/report spec
output/<skill>/       # generated artifacts per optimized skill
fixtures/             # sample target skills
```

## Design notes & honest caveats

- **Human gates and side-effect ordering are never compiled away.** Approval always precedes the
  external effect; required questions are always asked.
- **External MCP calls stay MCP calls.** If a skill uses a Linear/GitHub MCP, the optimizer keeps
  invoking that tool (you may have it configured but no API key/package to call it standalone) and
  feeds its results *into* helpers - it does not reimplement the transport as a raw API.
- **Jev is a baseline consumer of confidence, not an oracle.** Low-confidence decisions deopt to the
  agent. Calibrated confidence is the guardrail.
- **"before" is measured; "after" is modeled.** Token counts are exact from your transcripts; the
  savings estimate uses published reference rates and turn-count assumptions - multiply the exact
  counts by your own invoice rates for ground truth.
- Built as a high-intelligence coding-agent skill, not a new runtime. The generated helpers are
  small enough for a human to read, inspect, and delete.

## License

TBD.
