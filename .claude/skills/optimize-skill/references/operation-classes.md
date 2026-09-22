# Operation classes — the compiler model

Every step in a skill is classified into exactly one class. The class determines the cheapest
reliable primitive to compile it to. **The goal is to minimize generative model cognition on
the repeated path — not to remove capability.** When unsure, leave it on the agent.

The example column below is *illustrative* — drawn from a sample issue-tracker skill used while
building this optimizer. It is not a skill you need to have; map the pattern onto your target skill.

| Class | Compile to | What it looks like | Illustrative examples |
| --- | --- | --- | --- |
| **Deterministic** | Code | Parsing, arithmetic, fixed mappings, limits, validators — same input always gives same output | Read a config file; derive a value from a URL; a fixed type→label map; a type→template map; a numeric bucket; a length check; a forbidden-pattern check |
| **Bounded semantic** | Jev | A decision over a *closed, known* set: classify / yes-no / score / route / pick | A category/type; a priority bucket; "enough context?"; "relates to code?"; "would investigation help?"; an optional secondary label |
| **Generative** | LLM / agent | Open-ended writing or synthesis with no bounded answer set | Drafting a title + description prose |
| **Research / exploration** | Agent + tools | Investigate a codebase, web, or unknown state to form hypotheses | A brief codebase investigation |
| **External effect** | Existing MCP tool (kept) | Creates, updates, reads, or submits via a service | A create/update/get/list call to the skill's own MCP or API |
| **Human gate** | User interaction | Approval, assignment, explicit confirmation — a decision the human must own | A required routing/assignment question; a pre-action review/approval |

```
code ───────── Jev ───────── LLM
exact logic    bounded semantics    open-ended intelligence
```

The output is a **graph**, not necessarily one helper. Nodes of different classes interleave. Decide
helper count by **consolidation**: fold every *contiguous* run of compilable steps (code + Jev) into
a single helper; introduce a new helper only where a non-compiled node — reasoning, an MCP/tool
call, an agent investigation, or a human gate — must run in between.

```
[compile: classify + derive + config]  →  MCP call (kept)  →  [compile: constrain + validate]  →  human gate  →  MCP effect
        one helper                          (interruption)          one helper                     (interruption)
```

So `[A,B,C,D,E]` with no interruption = one helper; `[A,B,C] → MCP → [D,E]` = two (or one helper
invoked twice). Prefer the biggest helper the flow allows — fewer round-trips. A helper often takes
a prior tool/MCP result as input rather than fetching data itself.

## Classification decision tree

1. **Same input → same output, expressible as rules/tables?** → Deterministic (code). Never pay a
   model for a stable mapping.
2. **Answer is one of a known, closed set (a label, yes/no, an ordered level, a route)?** →
   Bounded semantic (Jev). The *program* owns the schema; Jev only supplies a value + probability.
   Then **design its context representation** (see `jev-design-rules.md`): identify the evidence a
   human uses for this decision and feed Jev the cheapest *sufficient* view of it — a lossy
   representation, not the model, is the usual cause of a bad compiled decision.
3. **Does it call an external service (create/modify OR read)?** → External effect. **Keep the
   existing MCP tool** — the agent already has it configured, and the user often has no API key or
   package to run it standalone. Do NOT reimplement it as a raw HTTP/SDK call inside a helper by
   default. Compile the *decision of what to send* and the *processing of the result* (a helper can
   take the tool's output as input), never the transport. Only compile to a direct API/package call
   when the user actually has the credentials + package and it's a clear win (batching, caching a
   stable read, dropping an empty/redundant call). Never move an effect before its gate.
4. **Must a human approve/choose/own it?** → Human gate. **Never compile away.** Preserve verbatim.
5. **Open-ended writing/planning/architecture/hypotheses?** → Generative / research. Leave on the
   agent — this is the value, not the waste.

## Anti-patterns (do not do)

- Forcing Jev onto genuinely generative work to cut a model call.
- Turning a stable invariant into a Jev call ("Bug→Bug label" is code, not a Choice).
- Hiding an external side-effect inside generated helper code.
- Removing or reordering a human gate relative to its side-effect.
- Treating a low-confidence Jev answer as ground truth instead of falling back to the agent.

"Not worth optimizing" is a valid, and sometimes correct, result.
