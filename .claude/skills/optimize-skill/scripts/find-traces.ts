/**
 * find-traces.ts
 *
 * Mines local agent history for REAL prior executions of a target skill, across multiple
 * agent stores (Claude Code and Codex). The hard part is honesty: a skill name appears in
 * every session's always-on "available skills" listing, so a naive substring count massively
 * overcounts (we measured ~570 "hits" for create-linear-issue that were all listings and 0
 * real runs). This miner separates:
 *
 *   - "listing"    : the one-line skill description in the available-skills context (ignored)
 *   - "invocation" : the skill was actually triggered (Skill tool_use / slash command /
 *                    attributionSkill / full SKILL.md body injected)
 *   - "run"        : an invocation with downstream evidence the procedure executed
 *                    (the skill's characteristic tool calls actually fired)
 *
 * Output is a JSON summary the SKILL uses to decide whether profile-guided optimization is
 * even possible, or whether to fall back to static optimization.
 *
 * Usage:
 *   bun find-traces.ts <skill-name> [--skill-path <SKILL.md>] [--json] [--limit N]
 *
 * Programmatic: import { findTraces } from "./find-traces.ts"
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";

export interface TraceHit {
  store: "claude-code" | "codex";
  file: string;
  cwd?: string;
  /** strongest classification found in this file for the target skill */
  level: "listing" | "invocation" | "run";
  /** what evidence produced the classification */
  evidence: string[];
  timestamp?: string;
}

export interface TraceSummary {
  skill: string;
  scanned: { store: string; files: number }[];
  hits: TraceHit[];
  counts: { listing: number; invocation: number; run: number };
  byProject: Record<string, { invocation: number; run: number }>;
  /** true when there is enough structured history to profile/replay against */
  profilable: boolean;
  note: string;
}

// ---- distinctive-phrase extraction (to detect a full skill-body injection) --------------

/** Pull a few low-frequency phrases from a SKILL.md body that would only appear if the whole
 *  skill was injected/executed, not merely listed. Falls back to nothing if unreadable. */
function distinctivePhrases(skillPath?: string): string[] {
  if (!skillPath || !existsSync(skillPath)) return [];
  let body = "";
  try {
    body = readFileSync(skillPath, "utf8");
  } catch {
    return [];
  }
  // strip frontmatter (the description there is what leaks into listings)
  body = body.replace(/^---[\s\S]*?---/, "");
  const candidates = body.match(/^#{1,4}\s+.{4,60}$/gm) ?? []; // headings are stable + distinctive
  const phrases = candidates.map((h) => h.replace(/^#{1,4}\s+/, "").trim()).filter((p) => p.length >= 5);
  // de-dup, cap
  return Array.from(new Set(phrases)).slice(0, 12);
}

// ---- store scanners --------------------------------------------------------------------

function listFiles(dir: string, ext: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(d, e);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (full.endsWith(ext)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/** Fast pre-filter: does the raw file even mention the skill? Avoids parsing 100% of history. */
function fileMentions(file: string, skill: string): boolean {
  try {
    return readFileSync(file, "utf8").includes(skill);
  } catch {
    return false;
  }
}

function classifyClaudeCode(file: string, skill: string, phrases: string[]): TraceHit | null {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const evidence: string[] = [];
  let level: TraceHit["level"] = "listing";
  let cwd: string | undefined;
  let ts: string | undefined;

  for (const line of raw.split("\n")) {
    if (!line.includes(skill) && !line.includes('"tool_use"') && !phrases.some((p) => line.includes(p))) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    cwd ??= o.cwd;
    ts ??= o.timestamp;
    // strongest: assistant messages attributed to this skill => it actually ran
    if (o.attributionSkill === skill) {
      level = "run";
      if (!evidence.includes("attributionSkill")) evidence.push("attributionSkill");
    }
    const content = o?.message?.content;
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === "tool_use" && b?.name === "Skill" && b?.input?.skill === skill) {
          if (level === "listing") level = "invocation";
          if (!evidence.includes("Skill tool_use")) evidence.push("Skill tool_use");
        }
      }
    }
    if (typeof content === "string" && content.includes(`<command-name>/${skill}`)) {
      if (level === "listing") level = "invocation";
      if (!evidence.includes("slash command")) evidence.push("slash command");
    }
    // full body injected => strong invocation signal
    if (phrases.length && phrases.filter((p) => line.includes(p)).length >= 2) {
      if (level === "listing") level = "invocation";
      if (!evidence.includes("skill body injected")) evidence.push("skill body injected");
    }
  }
  if (level === "listing" && evidence.length === 0) evidence.push("listing only");
  return { store: "claude-code", file, cwd, level, evidence, timestamp: ts };
}

function classifyCodex(file: string, skill: string, phrases: string[]): TraceHit | null {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const evidence: string[] = [];
  let level: TraceHit["level"] = "listing";
  let cwd: string | undefined;
  let ts: string | undefined;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const p = o.payload ?? {};
    if (o.type === "session_meta") {
      cwd ??= p.cwd;
      ts ??= p.timestamp;
    }
    // user slash invocation in a message
    if (o.type === "response_item" && p.type === "message") {
      const text = Array.isArray(p.content) ? p.content.map((c: any) => c?.text ?? "").join(" ") : "";
      if (p.role === "user" && text.includes(`/${skill}`)) {
        if (level === "listing") level = "invocation";
        if (!evidence.includes("slash command")) evidence.push("slash command");
      }
      // full skill body injected (developer/system message with >=2 distinctive phrases)
      if (phrases.length && phrases.filter((ph) => text.includes(ph)).length >= 2) {
        if (level === "listing") level = "invocation";
        if (!evidence.includes("skill body injected")) evidence.push("skill body injected");
      }
    }
  }
  if (level === "listing" && evidence.length === 0) evidence.push("listing only");
  return { store: "codex", file, cwd, level, evidence, timestamp: ts };
}

// ---- public API ------------------------------------------------------------------------

export function findTraces(skill: string, opts: { skillPath?: string; limit?: number } = {}): TraceSummary {
  const phrases = distinctivePhrases(opts.skillPath);
  const claudeDir = join(homedir(), ".claude", "projects");
  const codexDir = join(homedir(), ".codex", "sessions");

  const claudeFiles = existsSync(claudeDir) ? listFiles(claudeDir, ".jsonl") : [];
  const codexFiles = existsSync(codexDir) ? listFiles(codexDir, ".jsonl") : [];

  const hits: TraceHit[] = [];
  const consider = (files: string[], classify: (f: string) => TraceHit | null) => {
    for (const f of files) {
      if (!fileMentions(f, skill)) continue;
      const hit = classify(f);
      if (hit) hits.push(hit);
    }
  };
  consider(claudeFiles, (f) => classifyClaudeCode(f, skill, phrases));
  consider(codexFiles, (f) => classifyCodex(f, skill, phrases));

  const counts = { listing: 0, invocation: 0, run: 0 };
  const byProject: Record<string, { invocation: number; run: number }> = {};
  for (const h of hits) {
    counts[h.level]++;
    if (h.level !== "listing") {
      const key = h.cwd ?? "(unknown)";
      byProject[key] ??= { invocation: 0, run: 0 };
      if (h.level === "run") byProject[key].run++;
      else byProject[key].invocation++;
    }
  }

  const realRuns = counts.run;
  const profilable = realRuns >= 10;
  const note = profilable
    ? `${realRuns} runs available for profile-guided optimization.`
    : `Only ${realRuns} fully-executed runs found (${counts.invocation} invocations, ${counts.listing} listing-only mentions). ` +
      `Insufficient structured history for replay — recommend static-analysis optimization; wire traces in later.`;

  const nonListing = hits.filter((h) => h.level !== "listing");
  return {
    skill,
    scanned: [
      { store: "claude-code", files: claudeFiles.length },
      { store: "codex", files: codexFiles.length },
    ],
    hits: opts.limit ? nonListing.slice(0, opts.limit) : nonListing,
    counts,
    byProject,
    profilable,
    note,
  };
}

// CLI
if (import.meta.main) {
  const args = process.argv.slice(2);
  const skill = args.find((a) => !a.startsWith("--"));
  if (!skill) {
    console.error("usage: bun find-traces.ts <skill-name> [--skill-path <SKILL.md>] [--json] [--limit N]");
    process.exit(1);
  }
  const spIdx = args.indexOf("--skill-path");
  const skillPath = spIdx >= 0 ? args[spIdx + 1] : undefined;
  const limIdx = args.indexOf("--limit");
  const limit = limIdx >= 0 ? Number(args[limIdx + 1]) : undefined;

  const summary = findTraces(skill, { skillPath, limit });
  if (args.includes("--json")) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`Skill: ${summary.skill}`);
    console.log(`Scanned: ${summary.scanned.map((s) => `${s.files} ${s.store}`).join(", ")} files`);
    console.log(`Listing-only: ${summary.counts.listing}  Invocations: ${summary.counts.invocation}  Runs: ${summary.counts.run}`);
    if (Object.keys(summary.byProject).length) {
      console.log("By project (non-listing):");
      for (const [p, c] of Object.entries(summary.byProject)) console.log(`  run=${c.run} invoc=${c.invocation}  ${p}`);
    }
    console.log(`\nProfilable: ${summary.profilable}\n${summary.note}`);
  }
}
