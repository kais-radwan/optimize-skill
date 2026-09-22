/**
 * make-split.ts
 *
 * Caps a run corpus (default 100 — never replay huge history) and splits it into
 * development / validation / holdout sets (default 70/15/15). The split is deterministic
 * (seeded shuffle) so re-runs are reproducible, and stratified by cwd so no single project
 * dominates one split.
 *
 * Usage:
 *   bun make-split.ts --in runs.json --outdir <dir> [--cap 100] [--ratios 70,15,15] [--seed 42]
 * Programmatic: import { makeSplit } from "./make-split.ts"
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface SplitResult<T> {
  dev: T[];
  validation: T[];
  holdout: T[];
  meta: { total: number; capped: number; ratios: number[]; seed: number };
}

// deterministic PRNG (mulberry32) — no Math.random, so splits are reproducible
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: T[], rnd: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function makeSplit<T extends { cwd?: string }>(
  runs: T[],
  opts: { cap?: number; ratios?: [number, number, number]; seed?: number } = {},
): SplitResult<T> {
  const cap = opts.cap ?? 100;
  const ratios = opts.ratios ?? [70, 15, 15];
  const seed = opts.seed ?? 42;
  const rnd = mulberry32(seed);

  // stratify by cwd: shuffle within each project, then round-robin projects until we hit the cap.
  const byProject = new Map<string, T[]>();
  for (const r of runs) {
    const k = r.cwd ?? "(unknown)";
    if (!byProject.has(k)) byProject.set(k, []);
    byProject.get(k)!.push(r);
  }
  const buckets = [...byProject.values()].map((b) => shuffle(b, rnd));
  const capped: T[] = [];
  let progress = true;
  while (capped.length < cap && progress) {
    progress = false;
    for (const b of buckets) {
      if (b.length) {
        capped.push(b.shift()!);
        progress = true;
        if (capped.length >= cap) break;
      }
    }
  }

  const shuffled = shuffle(capped, rnd);
  const total = ratios[0] + ratios[1] + ratios[2];
  const nDev = Math.round((shuffled.length * ratios[0]) / total);
  const nVal = Math.round((shuffled.length * ratios[1]) / total);
  return {
    dev: shuffled.slice(0, nDev),
    validation: shuffled.slice(nDev, nDev + nVal),
    holdout: shuffled.slice(nDev + nVal),
    meta: { total: runs.length, capped: capped.length, ratios, seed },
  };
}

// CLI
if (import.meta.main) {
  const args = process.argv.slice(2);
  const get = (n: string) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const inPath = get("in");
  const outdir = get("outdir");
  if (!inPath || !outdir) {
    console.error("usage: bun make-split.ts --in runs.json --outdir <dir> [--cap 100] [--ratios 70,15,15] [--seed 42]");
    process.exit(1);
  }
  const runs = JSON.parse(readFileSync(inPath, "utf8"));
  const ratios = get("ratios")?.split(",").map(Number) as [number, number, number] | undefined;
  const split = makeSplit(runs, {
    cap: get("cap") ? Number(get("cap")) : undefined,
    ratios,
    seed: get("seed") ? Number(get("seed")) : undefined,
  });
  mkdirSync(outdir, { recursive: true });
  writeFileSync(join(outdir, "runs.dev.json"), JSON.stringify(split.dev, null, 2));
  writeFileSync(join(outdir, "runs.validation.json"), JSON.stringify(split.validation, null, 2));
  writeFileSync(join(outdir, "runs.holdout.json"), JSON.stringify(split.holdout, null, 2));
  console.log(
    JSON.stringify(
      { total: split.meta.total, capped: split.meta.capped, dev: split.dev.length, validation: split.validation.length, holdout: split.holdout.length, outdir },
      null,
      2,
    ),
  );
}
