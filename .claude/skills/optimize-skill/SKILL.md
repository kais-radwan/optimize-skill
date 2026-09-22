---
name: optimize-skill
description: Optimizes another agent skill by compiling its repetitive, bounded cognition into a small helper (code + Jev semantic decisions + existing tools), while preserving human gates, side-effect ordering, and genuinely generative work. Use when the user says "optimize skill", "compile this skill", "/optimize-skill <name>", or asks to make a skill cheaper/faster without changing its behavior or safety.
allowed-tools: Bash, Read, Glob, Grep, Edit, Write, AskUserQuestion, Task
---

# optimize-skill

A profile-guided compiler for agent skills. Given a target skill, it decides which operations
truly need generative intelligence and compiles the rest into a small, inspectable helper that
uses **code** (deterministic), **Jev** (bounded semantic decisions), and **existing tools**
(external effects). Human gates and side-effect controls are never compiled away.

> Core thesis: spend expensive intelligence **once** to remove unnecessary intelligence from the
> repeated execution path. Jev is an enabling primitive, not the goal. A trustworthy optimizer
> knows exactly where to stop — "not worth optimizing" is a valid result.

### What actually saves tokens (read before you optimize)

Think in **tokens**, not dollars — skills run in harnesses on monthly plans, so token usage is what
matters. Jev inference tokens are a rounding error. **The main lever is turn count.** Collapsing a
long, chatty agent loop (read → reason → read → reason …) into a compact subprocess call removes
turns — and because such skills run mid-session, each turn re-reads the whole cached conversation, so
**~98% of a run's tokens are cache read/write** (one skill we profiled averaged **~15 assistant turns
and ~1.18M cache-read tokens per run**). Fewer turns → fewer full-context re-reads → far fewer tokens.
Optimize for **turn count**, not for "number of model calls replaced by Jev." When you estimate
savings (step 10), turn reduction is the story.

**A secondary, optional lever — and one to use carefully:** when the agent genuinely does not need to
see a large raw blob (because a helper already decided everything that blob was for), the helper can
read it in a subprocess and return a compact result, so those bytes never hit the model's context.
But **do not starve the agent.** LLMs are good precisely because they process rich context well;
replacing context the agent actually uses — to write good prose, reason about a change, catch an
edge case — with a lossy JSON summary makes the agent worse and has real side effects. Only keep data
out of context when it's genuinely unused downstream. When in doubt, leave the data in the agent's
context and win on turns instead. Reducing capability is never an acceptable price for fewer tokens.

`SCRIPTS = .claude/skills/optimize-skill/scripts` · `REF = .claude/skills/optimize-skill/references`

> **About the examples in this skill.** The concrete cases below — a git-commit skill, a
> Linear-issue skill — are *illustrative* lessons from building and testing this optimizer. They are
> **not** skills that exist in the user's environment. Do not look for them, and do not assume the
> target skill resembles them; apply the underlying principle to whatever skill you were actually
> given.

## When invoked

Argument is the target skill name (e.g. `/optimize-skill <skill-name>`). Locate it in the
current project's `.claude/skills/<name>/` (or ask the user for the path). To avoid mutating a
live skill during development, you may operate on a copy and write artifacts under `output/<name>/`.

## Procedure

### 1. Read the whole target + how it's really used
Read the target `SKILL.md` in full plus everything it references: scripts, templates, config/data
files, and tool/MCP contracts. You must understand the real inputs, the tools it calls, and the
exact human gates before changing anything.

Then understand **how the skill is actually used and where it breaks** — this is not optional, and
it is where naive compilers fail. From the skill's own docs *and* the mined runs (step 3), write
down: the common request shapes, and the **edge cases** the skill must handle. Miss an edge case and
the helper ships a confident wrong answer. (Illustrative: when we tested this optimizer on a
git-commit skill, a first pass missed **untracked/new files** — invisible to `git diff` — and
**partial commits** — staging only a subset, so a whole-tree classification mislabels the subset.)
Every skill has its own such traps; enumerate them before you design anything, and treat each as a
required input the helper must handle or defer on.

### 2. Resolve Jev credentials
Run `bun $SCRIPTS/resolve-jev-credentials.ts --json`. If it exits with `need_credentials`, use
**AskUserQuestion** to ask the user which provider (`openrouter` | `typesafe`) and key to use,
then write `{provider, key, model?}` to the printed `writeTo` path. Never put the key in the repo.
Confirm with `bun $SCRIPTS/jev-probe.ts` that live decisions work before generating a helper.

### 3. Mine history (optional but preferred)
Run `bun $SCRIPTS/find-traces.ts <name> --skill-path <path/to/SKILL.md>`. This scans Claude Code
and Codex history and honestly separates *listings* from real *invocations* and *runs*.
- If it reports enough real **runs** (`profilable: true`, ≥10): use them as a profiling +
  evaluation corpus. Extract requests, questions/answers, tool calls, corrections, and outcomes;
  cap at **100 runs** and split ~70/15/15 dev/validation/holdout. Prefer explicit user corrections
  over the agent's first choice; keep ambiguous cases ambiguous; treat the old agent as a baseline,
  not an oracle.
- If not (the common case — on-disk history is short and skills rarely leave structured runs),
  proceed **static-first**: optimize from the skill's structure, and note the corpus gap in the
  report. Real ground truth can be added later (e.g. pulling past issues from the target tool's API).

### 4. Classify every operation — and design its context representation
Decompose the skill into ordered operations and classify each using `REF/operation-classes.md`:
deterministic → code, bounded-semantic → Jev, generative/research → agent, external-effect → tool,
human-gate → user. Write the classification table down; it becomes the manifest.

**Then, for every Jev node, compile the *context representation*, not just the decision.** This is a
first-class rule, not an afterthought — a perfectly reasonable Jev question looks mediocre if you
feed it a lossy view of the state. Do NOT think "agent classifies here → replace with Jev." Think:

```
SKILL OPERATION
      ↓  What evidence does the human/agent normally use to decide this?
      ↓  What is the cheapest *sufficient* representation of that evidence?
      ↓  Jev question (fed that representation)
```

Jev is a system-one model with a **32k context window** that outperforms most frontier models on
decision benchmarks. Give it enough context to be right.
Measured proof (illustrative — from testing this optimizer on a git-commit classification decision,
same question, only the representation changed):

| Representation fed to Jev | raw agreement | acted agreement | fallback |
| --- | --- | --- | --- |
| truncated ~302-char input | 52.9% | 75.0% | 62.4% |
| full input (~13k) | 67.9% | 79.7% | 29.8% |
| full input + per-item summary stat | **79.8%** | **89.2%** | 22.6% |

The entire gain came from representation. So for each Jev node, decide what evidence to gather
(often a deterministic pre-step in the helper: the full relevant input, a file slice, config, a
prior tool result, plus cheap derived signals) and feed a *sufficient* — not truncated — view.
Feeding Jev a large input is cheap and stays in the helper subprocess, so be generous with what Jev
sees. This is independent of what the *agent* sees downstream — the agent still gets whatever context
it needs to do its own job well.

### 5. Profile (if runs exist)
Find hot paths, invariants, redundant/empty tool calls, stable mappings, repeated bounded
decisions, and common exceptions. These tell you which nodes are worth compiling and which
mappings are stable enough to become code rather than Jev. Also mine the runs for the **edge cases
and evidence** from step 1: what state did the agent actually read before each decision (that is the
representation your Jev node needs), and which uncommon situations recur (feed step 1's edge-case list).

### 6. Design the compiled graph + generate helper(s)
Design a **graph** of nodes (code / Jev / tool / agent / human). Then decide how many helpers by
**consolidation, not fragmentation**:

- **Fold every *contiguous* run of compilable steps (deterministic code + bounded Jev) into ONE
  helper call.** If steps 1–5 are all compilable and nothing non-compiled sits between them, they
  are one helper, not five. Prefer the biggest helper the flow allows — fewer round-trips, less glue.
- **Split into another helper (or another invocation) only where a non-compiled node must run in
  between**: residual reasoning, an MCP/tool call, an agent investigation, or a human gate. The
  split points are dictated by those interruptions, never by a preference for "small" helpers.
- So the helper count = the number of contiguous compilable segments in the flow. A skill with
  `[compile A,B,C] → MCP call → [compile D,E]` yields two helpers (or one helper invoked twice, if
  D,E reuse the same logic with new input); `[compile A..E]` with no interruption yields one.

Within each helper, follow `REF/jev-design-rules.md`:
- Deterministic nodes = plain code (mappings, config reads, validators, limits).
- Bounded-semantic nodes = one batched Jev `decisions()` call via `$SCRIPTS/jev-client.ts` — batch
  ALL the Jev questions in that segment that share the same input into a single call.
- Every Jev value carries a confidence; below the threshold, set a `fallback` flag on that field.
- Helpers **consume** tool/MCP results as inputs when useful (e.g. pass fetched labels in via a
  flag) rather than fetching external data themselves — see the MCP rule below.
- Helpers return **decisions and derived deterministic values only**. They must NOT draft prose,
  ask the human gates, perform external effects, or bypass approval.
Keep each helper inspectable (a human should be able to read and delete it), but consolidated —
don't shrink it below what the contiguous compilable segment naturally contains.

**External MCP calls — keep the tool, don't reimplement it.** Do NOT convert an already-configured
external MCP tool (Linear, GitHub, etc.) into a raw HTTP/API or SDK call inside a helper. The user
usually has the MCP set up and ready in their agent but may have no API key or package to run it
standalone — so the compiled skill should keep invoking the **existing MCP tool** (the agent makes
the call), and helpers process the *results*. Only compile an MCP call into a direct API/package
call when (a) the user actually has the credentials + package AND (b) it's a clear win (batching,
caching a stable read, avoiding an empty/redundant call). When unsure, keep the MCP tool. Compile
the *decision of what to send / how to interpret the result*, never the transport by default.

### 7. Evaluate + iterate — build an end-to-end eval whenever possible
Always try to build an eval that runs the **real helper end-to-end** — the exact CLI the skill
invokes — against **reconstructed real state**, and measure agreement + fallback + confidence.

Two traps that will silently lie to you (both bit us while testing this optimizer):
- **Don't evaluate Jev directly, bypassing the helper.** A Jev-direct harness never exercises the
  helper's evidence-gathering, edge-case handling, or bugs (in one case an end-to-end eval caught an
  untracked-file blindness bug that a Jev-direct eval could not).
- **Don't trust truncated transcript text as the input.** `extract-runs` truncates outputs
  (~300 chars) for corpus size; replaying from that *starves* Jev and understates the helper (in the
  illustrative case above, 52.9% vs the real 79.8%). **Reconstruct the real state** instead — for a
  git skill, for instance, check out a detached worktree at each historical commit's parent,
  `cherry-pick --no-commit` then `reset` to recreate the pre-change tree, run the helper, and compare
  to what actually happened. Keep it read-only / isolated and clean up after. Adapt the same idea
  (reconstruct the real pre-decision state, run the real helper) to whatever your target skill does.

Then:
- With a corpus: run the e2e eval over dev, iterate on representation + thresholds, validate on the
  validation split, report the holdout once. Ground truth is the historical agent/user — a baseline,
  not an oracle; expect genuinely subjective boundaries to show as "disagreements" that the human
  gate catches anyway.
- No corpus (static-first): run the helper over representative inputs (clear/vague/critical/
  out-of-domain), check decisions + confidences are sensible and low-confidence trips fallback. Be
  explicit that this is not historical agreement.

### 8. Set confidence thresholds + deopt conditions
Define the fallback threshold and explicit deoptimization triggers (low confidence, unexpected tool
response, missing config, input outside the observed/declared domain, validator failure,
explicitly open-ended branch). Every fallback should be logged for future re-optimization.

### 9. Rewrite the skill around the helper
First **preserve the original verbatim as `SKILL.original.md`** (copy it before touching anything).
Then write the optimized skill as **`SKILL.md`** — it replaces the original in place, because
harnesses load `SKILL.md` (never `SKILL.optimized.md`). Keep the same frontmatter `name` so the
skill is still discovered. The optimized `SKILL.md`: runs the helper first; consumes its structured
decisions; asks only the *missing* context; **ALWAYS** keeps every mandatory human gate the original
had (any required question/approval); does research only when the helper indicates; keeps the
generative step (any open-ended writing) on the agent; runs deterministic validators; presents the
draft; and **NEVER** performs the external effect before approval. Route open-ended branches to the
original agentic path (reference `SKILL.original.md`). When operating on a copy under `output/<name>/`,
write both `SKILL.md` (optimized) and `SKILL.original.md` there.

### 10. Emit manifest + report (with the token analytics breakdown)
Write `manifest.json` and `report.md` per `REF/manifest-and-report.md`. Include a **token-usage
analytics breakdown** — lead with tokens, not dollars (users run skills on monthly plans):
- **Measured "before"** — real tokens per run for the skill's runs, summed from the transcripts.
  Run `bun $SCRIPTS/cost-analysis.ts <name> --json`; it sums per-message `usage` over the
  skill-attributed spans (input / cache-write / cache-read / output). Report the **per-run token
  total** and **turns/run**, and surface that **~98% of tokens are cache read/write** (the harness
  re-reads the cached conversation every turn). This half is real. (Dollars are optional/secondary —
  the script can price them, but plan users don't pay per token.)
- **Modeled "after"** — an *estimate*, clearly labeled as modeled and not measured, as **% fewer
  tokens/run**. Savings come primarily from **fewer turns** (the main lever, which cuts the dominant
  cache-read traffic); optionally a little more if some heavy data no longer needs to enter context
  (only when that doesn't cost the agent capability). Give a range (conservative/central/optimistic
  turn counts); state the assumptions.

Also report agreement (or N/A), fallback rate, tool calls avoided, edge cases covered vs deferred,
the e2e eval result, and a human-gate preservation checklist. If expected value is low, say
**"optimization not worthwhile"** and stop — that is a successful outcome, not a failure.

## Hard rules (never violate)

1. **Never remove or reorder a human gate** relative to its side-effect. Approval stays before creation.
2. **Never hide an external side-effect** inside generated helper code — effects stay in the skill,
   after their gate, via the existing tools. And do not reimplement an already-configured external
   MCP tool as a raw API/SDK call inside a helper by default; keep calling the MCP and feed results in.
3. **Never compile genuinely generative work** (writing, novel planning, architecture, hypotheses)
   just to cut model calls.
4. **Never treat Jev (or historical agent output) as an oracle.** Gate on calibrated confidence;
   fall back to the original agent when uncertain.
5. **Never silently change the policy** encoded by the source skill. Same behavior, thinner path.
6. **Always preserve a reversible original** and keep the helper small and inspectable.
7. **Compile the context representation, not just the decision.** Give each Jev node the evidence a
   human would use, in a sufficient (not truncated) form. A lossy representation, not Jev, is the
   usual cause of a bad compiled decision.
8. **Enumerate edge cases and build a real end-to-end eval** before declaring success. Test the
   actual helper against reconstructed real state — never a Jev-direct shortcut or truncated
   transcript text. Report the modeled "after" savings as modeled, and the measured "before" as measured.

## Artifacts

Per target: one helper per contiguous compilable segment (often just one — `get-<...>.ts`; more only
when non-compiled nodes interrupt) · **`SKILL.md`** (the optimized skill, replacing the original in
place) · **`SKILL.original.md`** (original preserved verbatim) · `manifest.json` · `report.md`. When
optimization is declined, leave `SKILL.md` untouched and write only a `report.md` explaining why.
