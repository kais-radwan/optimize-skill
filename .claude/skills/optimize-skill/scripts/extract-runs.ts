/**
 * extract-runs.ts
 *
 * Turns raw agent history into STRUCTURED runs of a target skill — the profiling + replay corpus.
 * Uses find-traces.ts to locate files, then segments each real execution into a faithful record:
 *
 *   { store, file, cwd, sessionId, ts, trigger, turns[], toolCalls[], questions[], outcome }
 *
 * It extracts the raw structure of what happened (the request, the tool calls + results, the
 * human Q&A gates, the final outcome) — NOT skill-specific decision labels. The optimizer derives
 * labels from these runs during optimization; keeping extraction generic makes it work for any skill.
 *
 * Claude Code: runs are maximal contiguous spans of assistant messages carrying
 *   `attributionSkill === skill` (interleaved tool_results/system lines stay in the span).
 * Codex: best-effort — from a slash/skill-body invocation, capture messages + function_calls +
 *   request_user_input Q&A until the task completes. (Codex has no per-message skill attribution.)
 *
 * Usage:
 *   bun extract-runs.ts <skill> [--skill-path <SKILL.md>] [--out runs.json] [--limit N]
 *                       [--include-invocations] [--max-text N]
 * Programmatic: import { extractRuns } from "./extract-runs.ts"
 */

import { readFileSync, writeFileSync } from "node:fs";
import { findTraces } from "./find-traces.ts";

export interface ToolCall {
  name: string;
  input: string; // trimmed
  result: string; // trimmed
  ok: boolean;
}
export interface QA {
  question: string;
  answer: string;
}
export interface Run {
  store: "claude-code" | "codex";
  file: string;
  cwd?: string;
  sessionId?: string;
  ts?: string;
  trigger: string; // the user request/command that started the run
  turns: { role: string; text: string }[];
  toolCalls: ToolCall[];
  questions: QA[];
  outcome: string;
}

let MAX_TEXT = 500;
const trim = (s: unknown, n = MAX_TEXT): string => {
  const str = typeof s === "string" ? s : JSON.stringify(s ?? "");
  return str.length > n ? str.slice(0, n) + "…" : str;
};

// ---- Claude Code -----------------------------------------------------------------------

function textFromContent(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === "text")
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

function extractClaudeRuns(file: string, skill: string): Run[] {
  let lines: any[];
  try {
    lines = readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }

  // Map tool_use id -> result text (from user tool_result messages).
  const resultById: Record<string, { text: string; ok: boolean }> = {};
  for (const o of lines) {
    const c = o?.message?.content;
    if (Array.isArray(c)) {
      for (const b of c) {
        if (b?.type === "tool_result") {
          const text =
            typeof b.content === "string"
              ? b.content
              : Array.isArray(b.content)
                ? b.content.map((x: any) => x?.text ?? "").join("\n")
                : JSON.stringify(b.content ?? "");
          resultById[b.tool_use_id] = { text, ok: !b.is_error };
        }
      }
    }
  }

  const runs: Run[] = [];
  let current: Run | null = null;
  let lastUserText = "";
  let pendingQuestion: string | null = null;

  const closeRun = () => {
    if (current) {
      // outcome = last assistant text in the run
      const lastText = [...current.turns].reverse().find((t) => t.role === "assistant" && t.text)?.text ?? "";
      current.outcome = trim(lastText);
      runs.push(current);
      current = null;
      pendingQuestion = null;
    }
  };

  for (const o of lines) {
    const type = o?.type;
    const attributed = o?.attributionSkill === skill;

    if (type === "user") {
      const content = o?.message?.content;
      const isToolResult = Array.isArray(content) && content.some((b: any) => b?.type === "tool_result");
      if (isToolResult) {
        // answer to a pending AskUserQuestion?
        if (current && pendingQuestion) {
          const ans = content.find((b: any) => b?.type === "tool_result");
          const ansText =
            typeof ans?.content === "string"
              ? ans.content
              : Array.isArray(ans?.content)
                ? ans.content.map((x: any) => x?.text ?? "").join("\n")
                : "";
          current.questions.push({ question: trim(pendingQuestion, 300), answer: trim(ansText, 300) });
          pendingQuestion = null;
        }
        continue; // tool results are attached via resultById already
      }
      // real human turn
      const txt = textFromContent(content);
      if (current) closeRun(); // a new human turn ends the current run
      lastUserText = txt || lastUserText;
      continue;
    }

    if (type === "assistant") {
      if (attributed) {
        if (!current) {
          current = {
            store: "claude-code",
            file,
            cwd: o.cwd,
            sessionId: o.sessionId,
            ts: o.timestamp,
            trigger: trim(lastUserText, 300),
            turns: [],
            toolCalls: [],
            questions: [],
            outcome: "",
          };
        }
        const content = o?.message?.content ?? [];
        const text = textFromContent(content);
        if (text.trim()) current.turns.push({ role: "assistant", text: trim(text) });
        if (Array.isArray(content)) {
          for (const b of content) {
            if (b?.type === "tool_use") {
              if (b.name === "AskUserQuestion") {
                // capture the question(s); answer arrives in the next tool_result
                const qs = (b.input?.questions ?? []).map((q: any) => q?.question ?? "").join(" | ");
                pendingQuestion = qs || JSON.stringify(b.input);
              }
              const res = resultById[b.id];
              current.toolCalls.push({
                name: b.name,
                input: trim(b.input, 300),
                result: trim(res?.text ?? "", 300),
                ok: res?.ok ?? true,
              });
            }
          }
        }
      } else {
        // assistant message not attributed to the skill -> the span has ended
        if (current) closeRun();
      }
      continue;
    }
    // system / mode / last-prompt / etc. inside a span: ignore, keep span open
  }
  closeRun();
  return runs;
}

// ---- Codex (best-effort) ---------------------------------------------------------------

function extractCodexRuns(file: string, skill: string, phrases: string[]): Run[] {
  let lines: any[];
  try {
    lines = readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }

  let cwd: string | undefined;
  let sessionId: string | undefined;
  let ts: string | undefined;
  for (const o of lines) {
    if (o?.type === "session_meta") {
      cwd = o.payload?.cwd;
      sessionId = o.payload?.session_id;
      ts = o.payload?.timestamp;
      break;
    }
  }

  // Find an invocation anchor: a user message with /skill, or a message with the skill body.
  let anchor = -1;
  for (let i = 0; i < lines.length; i++) {
    const p = lines[i]?.payload;
    if (lines[i]?.type !== "response_item" || p?.type !== "message") continue;
    const text = Array.isArray(p.content) ? p.content.map((c: any) => c?.text ?? "").join(" ") : "";
    if ((p.role === "user" && text.includes(`/${skill}`)) || (phrases.length && phrases.filter((ph) => text.includes(ph)).length >= 2)) {
      anchor = i;
      break;
    }
  }
  if (anchor < 0) return [];

  const run: Run = {
    store: "codex",
    file,
    cwd,
    sessionId,
    ts,
    trigger: "",
    turns: [],
    toolCalls: [],
    questions: [],
    outcome: "",
  };
  const outputById: Record<string, string> = {};
  for (const o of lines) {
    const p = o?.payload;
    if (o?.type === "response_item" && (p?.type === "function_call_output" || p?.type === "custom_tool_call_output")) {
      const out = Array.isArray(p.output) ? p.output.map((x: any) => x?.text ?? "").join("\n") : String(p.output ?? "");
      outputById[p.call_id] = out;
    }
  }

  // Walk forward from the anchor until the task completes.
  for (let i = anchor; i < lines.length; i++) {
    const o = lines[i];
    const p = o?.payload;
    if (o?.type === "event_msg" && p?.type === "task_complete" && i > anchor) break;
    if (o?.type !== "response_item") continue;
    if (p?.type === "message") {
      const text = Array.isArray(p.content) ? p.content.map((c: any) => c?.text ?? "").join("\n") : "";
      if (!text.trim()) continue;
      if (p.role === "user" && !run.trigger) run.trigger = trim(text, 300);
      if (p.role === "assistant" || p.role === "user") run.turns.push({ role: p.role, text: trim(text) });
    } else if (p?.type === "function_call" || p?.type === "custom_tool_call") {
      const name = p.type === "function_call" ? `${p.namespace ?? ""}::${p.name}` : p.name;
      if (name?.includes("request_user_input")) {
        run.questions.push({ question: trim(p.arguments ?? p.input, 300), answer: trim(outputById[p.call_id] ?? "", 300) });
      }
      run.toolCalls.push({ name: String(name), input: trim(p.arguments ?? p.input, 300), result: trim(outputById[p.call_id] ?? "", 300), ok: true });
    }
  }
  run.outcome = trim([...run.turns].reverse().find((t) => t.role === "assistant")?.text ?? "");
  return run.turns.length || run.toolCalls.length ? [run] : [];
}

// ---- public API ------------------------------------------------------------------------

export function extractRuns(
  skill: string,
  opts: { skillPath?: string; limit?: number; includeInvocations?: boolean; maxText?: number } = {},
): Run[] {
  if (opts.maxText) MAX_TEXT = opts.maxText;
  const summary = findTraces(skill, { skillPath: opts.skillPath });
  const phrases: string[] = []; // codex body-injection detection handled in classify already; anchor via slash
  const wanted = new Set(["run", ...(opts.includeInvocations ? ["invocation"] : [])]);
  const files = summary.hits.filter((h) => wanted.has(h.level));

  const runs: Run[] = [];
  for (const h of files) {
    const extracted = h.store === "claude-code" ? extractClaudeRuns(h.file, skill) : extractCodexRuns(h.file, skill, phrases);
    runs.push(...extracted);
    if (opts.limit && runs.length >= opts.limit) break;
  }
  // newest first
  runs.sort((a, b) => String(b.ts ?? "").localeCompare(String(a.ts ?? "")));
  return opts.limit ? runs.slice(0, opts.limit) : runs;
}

// CLI
if (import.meta.main) {
  const args = process.argv.slice(2);
  const skill = args.find((a) => !a.startsWith("--"));
  if (!skill) {
    console.error("usage: bun extract-runs.ts <skill> [--skill-path <SKILL.md>] [--out runs.json] [--limit N] [--include-invocations] [--max-text N]");
    process.exit(1);
  }
  const get = (n: string) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const runs = extractRuns(skill, {
    skillPath: get("skill-path"),
    limit: get("limit") ? Number(get("limit")) : undefined,
    includeInvocations: args.includes("--include-invocations"),
    maxText: get("max-text") ? Number(get("max-text")) : undefined,
  });
  const out = get("out");
  if (out) {
    writeFileSync(out, JSON.stringify(runs, null, 2));
    console.error(`wrote ${runs.length} runs -> ${out}`);
  } else {
    // summary to stdout
    const withQ = runs.filter((r) => r.questions.length).length;
    const withTools = runs.filter((r) => r.toolCalls.length).length;
    console.log(
      JSON.stringify(
        {
          skill,
          runs: runs.length,
          withQuestions: withQ,
          withToolCalls: withTools,
          byStore: runs.reduce<Record<string, number>>((a, r) => ((a[r.store] = (a[r.store] ?? 0) + 1), a), {}),
          sample: runs[0],
        },
        null,
        2,
      ),
    );
  }
}
