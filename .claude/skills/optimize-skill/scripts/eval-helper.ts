/**
 * eval-helper.ts
 *
 * Static-first evaluation harness. Runs a compiled helper over a set of representative inputs and
 * reports decision distributions, mean confidence per decision, fallback rate, and — where an
 * `expect` label is given — agreement. This is NOT historical replay (no agent traces exist for
 * the fixture); it exercises the helper and surfaces calibration. When a real corpus (or Linear
 * ground truth) is available, replace `expect` with mined labels for true behavioral agreement.
 *
 * Usage:
 *   bun eval-helper.ts --helper <path/to/helper.ts> --cases <cases.json> --cwd <repo> [--json]
 */

import { readFileSync } from "node:fs";

interface Case {
  name: string;
  content: string;
  expect?: Record<string, string>;
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function runHelper(helper: string, cwd: string, content: string): Promise<any> {
  const proc = Bun.spawn(["bun", helper, "--content", content, "--cwd", cwd], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  try {
    return JSON.parse(out);
  } catch {
    return { ok: false, parseError: out.slice(0, 400) };
  }
}

async function main() {
  const helper = arg("helper");
  const casesPath = arg("cases");
  const cwd = arg("cwd", process.cwd())!;
  if (!helper || !casesPath) {
    console.error("usage: bun eval-helper.ts --helper <helper.ts> --cases <cases.json> --cwd <repo> [--json]");
    process.exit(1);
  }
  const cases: Case[] = JSON.parse(readFileSync(casesPath, "utf8"));

  const rows: any[] = [];
  const confAcc: Record<string, number[]> = {};
  let fallbackNodes = 0;
  let totalNodes = 0;
  const agree: Record<string, { hit: number; n: number }> = {};

  for (const c of cases) {
    const r = await runHelper(helper, cwd, c.content);
    if (!r?.ok) {
      rows.push({ name: c.name, error: r?.deoptimize ?? r?.parseError ?? "unknown" });
      continue;
    }
    const d = r.decisions;
    for (const [k, v] of Object.entries<any>(d)) {
      (confAcc[k] ??= []).push(v.confidence);
      totalNodes++;
      if (v.fallback) fallbackNodes++;
    }
    // agreement vs expect
    for (const [k, want] of Object.entries(c.expect ?? {})) {
      agree[k] ??= { hit: 0, n: 0 };
      agree[k].n++;
      if (String(d[k]?.value) === String(want)) agree[k].hit++;
    }
    rows.push({
      name: c.name,
      route: r.route,
      type: `${d.issueType.value}@${d.issueType.confidence.toFixed(2)}`,
      priority: `${d.suggestedPriority.value}@${d.suggestedPriority.confidence.toFixed(2)}`,
      ctxSuff: `${d.contextSufficient.value}@${d.contextSufficient.confidence.toFixed(2)}`,
      needsInvestig: `${d.needsCodeInvestigation.value}@${d.needsCodeInvestigation.confidence.toFixed(2)}`,
      secondary: `${d.suggestedSecondaryLabel.value}@${d.suggestedSecondaryLabel.confidence.toFixed(2)}`,
      primaryLabel: r.derived.primaryLabel,
      needsAgentFallback: r.needsAgentFallback,
    });
  }

  const meanConf: Record<string, number> = {};
  for (const [k, xs] of Object.entries(confAcc)) meanConf[k] = xs.reduce((a, b) => a + b, 0) / xs.length;

  const summary = {
    cases: cases.length,
    meanConfidence: Object.fromEntries(Object.entries(meanConf).map(([k, v]) => [k, Number(v.toFixed(3))])),
    fallbackRate: Number((fallbackNodes / Math.max(1, totalNodes)).toFixed(3)),
    agreement: Object.fromEntries(Object.entries(agree).map(([k, v]) => [k, `${v.hit}/${v.n}`])),
    rows,
  };

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`Cases: ${summary.cases}`);
    console.log("Mean confidence:", summary.meanConfidence);
    console.log("Fallback rate (per decision node):", summary.fallbackRate);
    console.log("Agreement vs expect:", summary.agreement);
    console.log("\nPer-case:");
    for (const r of rows) {
      if (r.error) {
        console.log(`  ✗ ${r.name}: ${r.error}`);
      } else {
        console.log(`  • ${r.name}\n      route=${r.route} type=${r.type} prio=${r.priority} ctx=${r.ctxSuff} investig=${r.needsInvestig} 2ndary=${r.secondary}`);
      }
    }
  }
}

main();
