# Jev design rules

Jev (TypeSafe's "System One" model) answers **bounded** questions with a typed value AND a
calibrated probability, instead of generating text. Use it only for closed/bounded semantic
decisions. The **program owns the output schema**; Jev supplies bounded values and probabilities
and can never invent fields or values outside the program-defined domain.

Reach it through `scripts/jev-client.ts` (`choice` / `noul` / `score`), which normalizes both
the OpenRouter and native-TypeSafe providers. Credentials come from
`scripts/resolve-jev-credentials.ts`.

## The primitives

- **Choice** — route / classify into named options. `choice(instructions, {key: "what it means", …})`.
  Returns `{value: key, confidence, probabilities}`. Use for: issue type, priority bucket, label,
  fast/slow route.
- **Noul** (yes/no) — a calibrated probability 0→1. `noul(instructions)`. Returns
  `{value: boolean, confidence}` where confidence = |p−0.5|·2 (0.5 = undecided). Use for: enough
  context?, relevance, evidence support, is investigation useful?
- **Score** — an ordered scale. `score(instructions, ["low …", "moderate …", "high …"])`. Returns a
  fractional position + confidence. Use for: severity, complexity, quality — anything ordered.

## Context representation — the most important rule

**Compile the representation, not just the decision.** The single biggest lever on Jev quality is
*what state you let it see*, not the wording of the question. A reasonable question looks mediocre on
a lossy representation and excellent on a sufficient one.

Jev has a **32k-token context window** and outperforms most frontier models on decision benchmarks —
treat it like a strong classification model, not an outdated classifier. Give it the evidence a human would
actually use. For each node ask:

```
What evidence does the human/agent normally use to decide this?
      ↓
What is the cheapest *sufficient* representation of that evidence?  (sufficient ≠ shortest)
      ↓
Feed that to the Jev question.
```

Measured proof (illustrative — from a git-commit classification decision tested while building this
optimizer; identical question, only representation changed): truncated 302-char input → **52.9%**
agreement / 62% fallback; full input → **67.9%** / 30%; full input + a per-item summary stat →
**79.8%** / 23%. The gain was entirely representation. Low confidence usually means Jev is *starved*,
not wrong — add evidence before you blame the model.

Do the evidence-gathering as a deterministic pre-step inside the helper (read the full relevant
input, a file slice, config, a prior tool result, plus cheap derived signals). Feeding Jev a large
input is cheap and happens in the helper subprocess, so be generous with what *Jev* sees. This is
separate from what the *agent* sees: never trade away the agent's context to save tokens (see the
money note) — the helper reading a big input for Jev does not mean the agent should be denied it.

## Rules

1. **Bounded only.** If you can't write the closed option set / scale up front, it's not a Jev node.
2. **Program owns the schema.** Jev fills in bounded values; the surrounding code assembles the final
   structured output, applies mappings, and enforces invariants.
3. **Every decision carries a confidence.** Set a per-node threshold. Below it → the node is
   *undecided* and the skill **falls back to the original agent** for that decision (deoptimize).
4. **Structured output ≠ free-form JSON.** Don't use Jev to "generate JSON." It decides; it does not
   author prose or open-ended structures.
5. **Jev can still be semantically wrong.** It just can't produce out-of-domain values. Calibrated
   confidence is the guardrail — use it, don't assume correctness.
6. **Instructions are declarative predicates.** Phrase Noul instructions as a proposition to judge
   ("There is enough detail to write a clear issue without asking the user"), not a question.

## Cost

OpenRouter `typesafe/jev-1.13`: ~$0.042 / M input tokens, output free; 70–500 ms/call. **Jev cost is
a rounding error** — do not optimize for it. The real savings come from **fewer agent turns** (each
removed turn also removes a full re-read of the cached session context). Keeping some heavy raw data
out of the model context is a secondary, optional win — only when the agent doesn't need it; never
starve the agent to save tokens. So spend Jev tokens freely on a *rich* representation if it improves
the decision — the cost that matters is the agent's, not Jev's.
