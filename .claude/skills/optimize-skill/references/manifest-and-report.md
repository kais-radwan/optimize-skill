# Optimization manifest + report

Every optimization run produces two artifacts alongside the rewritten skill.

## `manifest.json`

Machine-readable record of what was compiled, what was preserved, and the fallback policy. It
enables `--reevaluate` when the skill changes, Jev improves, or new traces accumulate.

Illustrative shape (node names are examples — use whatever your target skill's operations are):

```json
{
  "skill": "<skill-name>",
  "optimizedFrom": "sha256:<hash of the original SKILL.md>",
  "optimizedAt": "<ISO timestamp>",
  "optimizer": "optimize-skill@<version>",
  "corpus": { "source": "static | history | api", "runs": 0, "note": "..." },
  "compiled": {
    "<classify_node>": "jev:choice",
    "<yesno_node>": "jev:noul",
    "<severity_node>": "jev:score",
    "<fixed_mapping>": "code",
    "<config_read>": "code",
    "<validators>": "code"
  },
  "preserved": {
    "<generative_step>": "agent",
    "<investigation>": "agent",
    "<open_ended_branch>": "agent",
    "<required_question>": "human",
    "<review_approval>": "human",
    "<external_effect>": "tool:<server>"
  },
  "fallback": { "confidenceBelow": 0.80, "action": "original_agent" },
  "artifacts": { "helpers": ["<helper>.ts"], "optimized": "SKILL.md", "original": "SKILL.original.md", "report": "report.md" }
}
```

`compiled` = nodes moved off the LLM path (value = primitive). `preserved` = nodes intentionally
left on agent / human / tool. Every human and external-effect node MUST appear under `preserved`.
`artifacts.helpers` is a **list**, but consolidate: one helper per *contiguous* compilable segment
(fold all adjacent code + Jev steps together), splitting only where a non-compiled node — reasoning,
an MCP/tool call, an agent, or a human gate — interrupts. Often that's a single helper. External-
effect nodes preserved as MCP tools should be marked `tool:<server>` (kept as the configured MCP
call), not converted to an API.

## `report.md`

Human-readable evaluation. Report only what is true — if there was no historical corpus, say so;
do not fabricate agreement numbers.

Include, per §15 metrics:

| Metric | What to report |
| --- | --- |
| LLM calls/tokens per invocation | Estimated before vs after (which reasoning steps the helper removes) |
| Jev cost per invocation | Number of Jev calls × ~$0.042/M in |
| Latency | Rough before/after |
| Behavioral agreement | vs. historical/ground-truth runs — **omit or mark N/A if no corpus** |
| User-correction agreement | vs. corrected labels, if available |
| Fallback / deopt rate | Over the eval inputs, how often confidence tripped fallback |
| Tool calls avoided | e.g. redundant label fetches, empty searches |
| Human-gate preservation | Explicit checklist: each gate still present + before its side-effect |
| Error / side-effect rate | Any unsafe reordering introduced (must be zero) |
| Edge cases | Which real-usage edge cases the helper handles vs. defers (from step 1) |
| End-to-end eval | Result of running the REAL helper against reconstructed state (raw + gated agreement, fallback) |
| Optimization build cost | One-time cost to amortize |

### Analytics breakdown (token usage) — required

**Lead with tokens, not dollars.** Skills run in harnesses on monthly plans, not per-token API
billing, so tokens are the metric that matters to users. Report dollars only as an optional aside if
asked. Split clearly into **measured** and **modeled** — never present the "after" as measured.

- **Measured "before"** (real, from transcripts): a table of tokens per run for the skill's runs —
  input (uncached), cache write, cache read, output — with the **per-run total** and **avg assistant
  turns/run**. Produced by `scripts/cost-analysis.ts` (`--json` gives the token buckets). Surface the
  headline: for mid-session skills **~98% of tokens are cache read/write**, because the harness
  re-reads the whole cached conversation every turn. The buckets are disjoint (total = input +
  cache_creation + cache_read), so summing them is not double-counting.
- **Modeled "after"** (estimate — label it as such): savings come mainly from **fewer turns** (each
  removed turn removes a full cached-context re-read, which is the dominant token cost), and optionally
  a little more when some heavy data no longer needs to enter context — but only where that doesn't
  reduce the agent's capability; never a lossy summary in place of context the agent uses. Jev adds a
  few thousand tokens/run — noise against a 1M+ baseline. Give a range (conservative/central/optimistic
  turn counts) as **% fewer tokens/run** and state assumptions.

Example shape (illustrative, from one mid-session skill we measured): **~1.36M tokens/run over ~15
turns**, of which **cache-read ~1.18M and cache-write ~0.15M (~98% of tokens)**; input ~0.02M, output
~0.007M. The takeaway to surface: token usage is dominated by cache read/write from a long mid-session
loop — which is exactly what fewer turns attacks. (If a dollar figure is ever needed, `cost-analysis.ts`
can price it, but that is secondary — plan users don't pay per token.)

End with an **honest verdict**: what was compiled, what was deliberately left, the measured-before /
modeled-after savings, edge-case coverage, and — if expected value is low — a clear "not worthwhile"
recommendation.
