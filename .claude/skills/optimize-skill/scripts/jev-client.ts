/**
 * jev-client.ts
 *
 * A thin, provider-abstracted adapter over Jev — TypeSafe AI's "System One" typed-decision
 * model. Jev answers bounded questions (Choice / Noul / Score) with a typed value AND a
 * calibrated probability, instead of generating free-form text. Compiled skill helpers use
 * this for the bounded-semantic nodes of a skill; the calling PROGRAM always owns the schema.
 *
 * Providers:
 *   - "openrouter": POST https://openrouter.ai/api/alpha/decisions  (Bearer key)
 *   - "typesafe":   native TypeSafe REST (client.systemOne equivalent)
 *
 * Both are normalized to one shape:
 *   decisions({ state, questions }) -> { answers: { key: NormalizedAnswer } }
 *
 * NOTE: the exact OpenRouter request envelope is confirmed by jev-probe.ts against the live
 * API. If the probe shows a different envelope, adjust buildRequest()/parseResponse() here.
 */

import type { JevCredentials } from "./resolve-jev-credentials.ts";

// ---- Question definitions (what the program asks) --------------------------------------

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  /** option key -> description of what that option means */
  criteria: Record<string, string>;
}
export interface NoulQuestion {
  type: "noul";
  instructions: string;
}
export interface ScoreQuestion {
  type: "score";
  instructions: string;
  /** ordered levels from low to high, each a short description */
  criteria: string[];
}
export type JevQuestion = ChoiceQuestion | NoulQuestion | ScoreQuestion;

export const choice = (instructions: string, criteria: Record<string, string>): ChoiceQuestion => ({
  type: "choice",
  instructions,
  criteria,
});
export const noul = (instructions: string): NoulQuestion => ({ type: "noul", instructions });
export const score = (instructions: string, criteria: string[]): ScoreQuestion => ({
  type: "score",
  instructions,
  criteria,
});

// ---- Normalized answers (what the program consumes) ------------------------------------

export interface NormalizedAnswer {
  type: "choice" | "noul" | "score";
  /** For choice: the selected option key. For noul: boolean (prob >= 0.5). For score: the numeric position. */
  value: string | number | boolean;
  /**
   * Calibrated confidence in [0,1]. For Choice/Score this is Jev's own `confidence`.
   * For Noul there is no separate confidence field — the probability IS the certainty, so we
   * derive confidence = |p - 0.5| * 2 (0.5 => undecided => 0 confidence; 0/1 => full confidence).
   */
  confidence: number;
  /** Raw probability distribution when available (choice: per-option; noul: the yes-probability; score: per-level). */
  probabilities?: Record<string, number> | number[] | number;
  /** The raw provider answer object, for debugging. */
  raw?: unknown;
}

export interface DecisionsResult {
  answers: Record<string, NormalizedAnswer>;
  /** provider + model actually used */
  meta: { provider: string; model: string };
}

export interface DecisionsInput {
  state: string | Record<string, unknown> | unknown[];
  questions: Record<string, JevQuestion>;
}

const DEFAULT_MODEL: Record<string, string> = {
  openrouter: "typesafe/jev-1.13",
  typesafe: "jev-1.13",
};

const OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
const TYPESAFE_DECISIONS_URL = "https://api.typesafe.ai/v1/system-one";

// ---- Request/response shaping ----------------------------------------------------------

function buildRequestBody(model: string, input: DecisionsInput): unknown {
  // Jev's documented body: { model, state, questions }. Question types are capitalized
  // (Noul/Choice/Score) with instructions and (for Choice/Score) criteria.
  return { model, state: input.state, questions: input.questions };
}

function deriveConfidence(ans: any, kind: "choice" | "noul" | "score"): number {
  if (kind === "noul") {
    const p = typeof ans?.noul === "number" ? ans.noul : typeof ans === "number" ? ans : 0.5;
    return Math.min(1, Math.abs(p - 0.5) * 2);
  }
  if (typeof ans?.confidence === "number") return ans.confidence;
  // Fall back to top probability mass if confidence not provided.
  const probs = ans?.probabilities;
  if (Array.isArray(probs)) return Math.max(...probs, 0);
  if (probs && typeof probs === "object") return Math.max(...(Object.values(probs) as number[]), 0);
  return 0.5;
}

/** Normalize one provider answer (already keyed) into NormalizedAnswer given the question kind. */
export function normalizeAnswer(kind: "choice" | "noul" | "score", ans: any): NormalizedAnswer {
  if (kind === "noul") {
    const p = typeof ans?.noul === "number" ? ans.noul : typeof ans === "number" ? ans : 0.5;
    return { type: "noul", value: p >= 0.5, confidence: deriveConfidence(ans, "noul"), probabilities: p, raw: ans };
  }
  if (kind === "choice") {
    return {
      type: "choice",
      value: ans?.choice ?? ans?.value ?? "",
      confidence: deriveConfidence(ans, "choice"),
      probabilities: ans?.probabilities,
      raw: ans,
    };
  }
  // Score
  return {
    type: "score",
    value: typeof ans?.score === "number" ? ans.score : Number(ans?.value ?? 0),
    confidence: deriveConfidence(ans, "score"),
    probabilities: ans?.probabilities,
    raw: ans,
  };
}

function parseResponse(json: any, questions: Record<string, JevQuestion>): Record<string, NormalizedAnswer> {
  const answersRaw = json?.answers ?? json?.decision?.answers ?? {};
  const out: Record<string, NormalizedAnswer> = {};
  for (const [key, q] of Object.entries(questions)) {
    const a = answersRaw[key];
    if (a === undefined) continue;
    out[key] = normalizeAnswer(q.type, a);
  }
  return out;
}

// ---- Public API ------------------------------------------------------------------------

export class JevClient {
  constructor(private creds: JevCredentials) {}

  get model(): string {
    return this.creds.model ?? DEFAULT_MODEL[this.creds.provider];
  }

  async decisions(input: DecisionsInput): Promise<DecisionsResult> {
    const model = this.model;
    const body = buildRequestBody(model, input);
    const url = this.creds.provider === "openrouter" ? OPENROUTER_DECISIONS_URL : TYPESAFE_DECISIONS_URL;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.creds.key}`,
        // OpenRouter attribution headers (optional but polite):
        "http-referer": "https://github.com/optimize-skill",
        "x-title": "optimize-skill",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new JevError(`Jev request failed: ${res.status} ${res.statusText}`, res.status, text);
    }
    const json = await res.json();
    return { answers: parseResponse(json, input.questions), meta: { provider: this.creds.provider, model } };
  }
}

export class JevError extends Error {
  constructor(message: string, public status?: number, public body?: string) {
    super(message);
    this.name = "JevError";
  }
}
