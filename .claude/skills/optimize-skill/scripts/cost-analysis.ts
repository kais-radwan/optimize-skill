/**
 * cost-analysis.ts
 *
 * The analytics half of an optimization report. Produces a MEASURED "before" (real billed tokens
 * for a skill's runs, summed from Claude Code transcripts) and a MODELED "after" (an estimate —
 * clearly labeled — of the optimized path). Only "before" is measured; never present "after" as fact.
 *
 * Why this matters: for a mid-session skill the bill is dominated by cache writes/reads from a long
 * agent loop, NOT by output or by Jev. Savings come mainly from (1) fewer assistant turns (each
 * removed turn removes a full cached-context re-read); optionally a little more if (2) some heavy raw
 * data no longer needs to enter context — but only when that doesn't cost the agent capability, never
 * a lossy summary in place of context the agent uses. The model scales cost by turn count, with a
 * modest cache-write reduction knob for (2).
 *
 * Token accounting per assistant message `usage`:
 *   total prompt = input_tokens (uncached remainder) + cache_creation_input_tokens + cache_read_input_tokens
 * These three buckets are DISJOINT, so summing them at separate rates is not double-counting.
 * Cache-creation is split 1h vs 5m when the transcript records it (cache_creation.ephemeral_*).
 *
 * Pricing multipliers (× base input): cache read 0.1×, cache write 1h 2×, cache write 5m 1.25×.
 * Default rates are Opus 4.8 ($/MTok, from the claude-api reference): input 5, output 25.
 * Override with --input/--output/--model, or edit PRICING. Token COUNTS are exact from transcripts;
 * rates are the published reference rates — multiply counts by your invoice rates for ground truth.
 *
 * Usage:
 *   bun cost-analysis.ts <skill> [--json] [--input 5] [--output 25] [--after-turns 8,6,5]
 * Programmatic: import { costAnalysis } from "./cost-analysis.ts"
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";

interface Buckets {
  input: number;
  cacheWrite1h: number;
  cacheWrite5m: number;
  cacheRead: number;
  output: number;
  msgs: number;
}
const zero = (): Buckets => ({ input: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 0, msgs: 0 });

export interface CostReport {
  skill: string;
  model: string;
  rates: Record<string, number>;
  dateRange: { from: string; to: string };
  runs: number;
  totalTurns: number;
  measured: { tokens: Buckets; cost: Record<string, number>; total: number; perRun: number; turnsPerRun: number };
  modeled: { scenario: string; turns: number; total: number; perRun: number; saved: number; savedPct: number }[];
  codexRunsExcluded: number;
  note: string;
}

function listJsonl(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let es: string[];
    try {
      es = readdirSync(d);
    } catch {
      return;
    }
    for (const e of es) {
      const full = join(d, e);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (full.endsWith(".jsonl")) out.push(full);
    }
  };
  walk(dir);
  return out;
}

export function costAnalysis(
  skill: string,
  opts: { inputRate?: number; outputRate?: number; model?: string; afterTurns?: number[] } = {},
): CostReport {
  const inputRate = opts.inputRate ?? 5.0;
  const outputRate = opts.outputRate ?? 25.0;
  const PRICING = {
    input: inputRate,
    output: outputRate,
    cacheWrite1h: inputRate * 2.0,
    cacheWrite5m: inputRate * 1.25,
    cacheRead: inputRate * 0.1,
  };
  const model = opts.model ?? "claude-opus-4-8";

  const claudeDir = join(homedir(), ".claude", "projects");
  const codexDir = join(homedir(), ".codex", "sessions");
  const attr = `"attributionSkill":"${skill}"`;

  const tot = zero();
  const perRun: Buckets[] = [];
  let from = "9999",
    to = "0000";
  const files = existsSync(claudeDir) ? listJsonl(claudeDir) : [];
  for (const f of files) {
    let raw: string;
    try {
      raw = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    if (!raw.includes(attr)) continue;
    let cur: Buckets | null = null;
    for (const line of raw.split("\n")) {
      if (!line) continue;
      let o: any;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      const isSkill = o.attributionSkill === skill;
      const u = o?.message?.usage;
      if (isSkill && u) {
        const cc = u.cache_creation ?? {};
        const w1h = cc.ephemeral_1h_input_tokens ?? (cc.ephemeral_5m_input_tokens != null ? 0 : u.cache_creation_input_tokens ?? 0);
        const w5m = cc.ephemeral_5m_input_tokens ?? 0;
        const add = (b: Buckets) => {
          b.input += u.input_tokens || 0;
          b.cacheWrite1h += w1h || 0;
          b.cacheWrite5m += w5m || 0;
          b.cacheRead += u.cache_read_input_tokens || 0;
          b.output += u.output_tokens || 0;
          b.msgs++;
        };
        add(tot);
        if (!cur) {
          cur = zero();
          perRun.push(cur);
        }
        add(cur);
        if (o.timestamp) {
          if (o.timestamp < from) from = o.timestamp;
          if (o.timestamp > to) to = o.timestamp;
        }
      } else if (o.type === "assistant" && !isSkill) {
        cur = null; // span breaks only on a non-skill ASSISTANT turn
      }
    }
  }

  // Codex: no comparable per-message usage/attribution — count & exclude.
  let codexRuns = 0;
  if (existsSync(codexDir)) {
    for (const f of listJsonl(codexDir)) {
      try {
        if (readFileSync(f, "utf8").includes(`/${skill}`)) codexRuns++;
      } catch {}
    }
  }

  const cost = (b: Buckets) =>
    (b.input * PRICING.input +
      b.cacheWrite1h * PRICING.cacheWrite1h +
      b.cacheWrite5m * PRICING.cacheWrite5m +
      b.cacheRead * PRICING.cacheRead +
      b.output * PRICING.output) /
    1e6;

  const runs = perRun.length || 1;
  const totalBefore = cost(tot);
  const turnsPerRun = tot.msgs / runs;

  // Modeled after: scale by turn ratio (input/cacheRead/output) + cache-write ratio (diffs leave context).
  const afterTurns = opts.afterTurns ?? [Math.round(turnsPerRun * 0.55), Math.round(turnsPerRun * 0.4), Math.round(turnsPerRun * 0.3)];
  const labels = ["conservative", "central", "optimistic"];
  const jevPerRun = (4000 * 0.042) / 1e6; // ~one Jev call/run, negligible
  const modeled = afterTurns.map((turns, i) => {
    const turnRatio = Math.min(1, turns / turnsPerRun);
    const cacheWriteRatio = [0.55, 0.4, 0.3][i] ?? turnRatio;
    const per: Buckets = {
      input: (tot.input / runs) * turnRatio,
      cacheWrite1h: (tot.cacheWrite1h / runs) * cacheWriteRatio,
      cacheWrite5m: (tot.cacheWrite5m / runs) * cacheWriteRatio,
      cacheRead: (tot.cacheRead / runs) * turnRatio,
      output: (tot.output / runs) * turnRatio,
      msgs: 0,
    };
    const perRunAfter = cost(per) + jevPerRun;
    const total = perRunAfter * runs;
    return {
      scenario: `${labels[i] ?? "scenario"} (turns ${turnsPerRun.toFixed(0)}→${turns})`,
      turns,
      total: Number(total.toFixed(2)),
      perRun: Number(perRunAfter.toFixed(3)),
      saved: Number((totalBefore - total).toFixed(2)),
      savedPct: Number(((100 * (totalBefore - total)) / totalBefore).toFixed(1)),
    };
  });

  return {
    skill,
    model,
    rates: PRICING,
    dateRange: { from: from === "9999" ? "n/a" : from, to: to === "0000" ? "n/a" : to },
    runs,
    totalTurns: tot.msgs,
    measured: {
      tokens: tot,
      cost: {
        input: Number(((tot.input * PRICING.input) / 1e6).toFixed(2)),
        cacheWrite1h: Number(((tot.cacheWrite1h * PRICING.cacheWrite1h) / 1e6).toFixed(2)),
        cacheWrite5m: Number(((tot.cacheWrite5m * PRICING.cacheWrite5m) / 1e6).toFixed(2)),
        cacheRead: Number(((tot.cacheRead * PRICING.cacheRead) / 1e6).toFixed(2)),
        output: Number(((tot.output * PRICING.output) / 1e6).toFixed(2)),
      },
      total: Number(totalBefore.toFixed(2)),
      perRun: Number((totalBefore / runs).toFixed(3)),
      turnsPerRun: Number(turnsPerRun.toFixed(1)),
    },
    modeled,
    codexRunsExcluded: codexRuns,
    note: "measured 'before' is real billed tokens from transcripts; modeled 'after' is an estimate (turn-count + cache-write reduction), not measured. Rates are published reference rates; token counts are exact.",
  };
}

// CLI
if (import.meta.main) {
  const args = process.argv.slice(2);
  const skill = args.find((a) => !a.startsWith("--"));
  if (!skill) {
    console.error("usage: bun cost-analysis.ts <skill> [--json] [--input 5] [--output 25] [--after-turns 8,6,5]");
    process.exit(1);
  }
  const get = (n: string) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const r = costAnalysis(skill, {
    inputRate: get("input") ? Number(get("input")) : undefined,
    outputRate: get("output") ? Number(get("output")) : undefined,
    afterTurns: get("after-turns")?.split(",").map(Number),
  });
  if (args.includes("--json")) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    const k = (n: number) => n.toLocaleString();
    console.log(`Skill: ${r.skill}  Model: ${r.model}  Runs: ${r.runs}  (${r.dateRange.from.slice(0, 10)} → ${r.dateRange.to.slice(0, 10)})`);
    if (r.codexRunsExcluded) console.log(`(Codex excluded from cost — no per-message usage data; ${r.codexRunsExcluded} codex sessions mention the skill)`);
    console.log(`\n=== MEASURED "BEFORE" (real billed tokens, ${r.measured.turnsPerRun} turns/run) ===`);
    const m = r.measured;
    console.log(`  input        ${k(m.tokens.input).padStart(13)}  $${m.cost.input}`);
    console.log(`  cache write1h${k(m.tokens.cacheWrite1h).padStart(13)}  $${m.cost.cacheWrite1h}  (${((100 * m.cost.cacheWrite1h) / m.total).toFixed(0)}% of spend)`);
    if (m.tokens.cacheWrite5m) console.log(`  cache write5m${k(m.tokens.cacheWrite5m).padStart(13)}  $${m.cost.cacheWrite5m}`);
    console.log(`  cache read   ${k(m.tokens.cacheRead).padStart(13)}  $${m.cost.cacheRead}`);
    console.log(`  output       ${k(m.tokens.output).padStart(13)}  $${m.cost.output}`);
    console.log(`  TOTAL: $${m.total}  ($${m.perRun}/run)`);
    console.log(`\n=== MODELED "AFTER" (estimate — turn count is the lever, not Jev) ===`);
    for (const s of r.modeled) console.log(`  ${s.scenario.padEnd(30)} $${s.total} total ($${s.perRun}/run)  SAVED $${s.saved} (${s.savedPct}%)`);
    console.log(`\n${r.note}`);
  }
}
