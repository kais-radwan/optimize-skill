/**
 * resolve-jev-credentials.ts
 *
 * Jev is the bounded-semantic-decision primitive used by compiled helpers. It can be
 * reached through different providers (OpenRouter, native TypeSafe). This resolver finds
 * a structured {provider, key} credential without ever hardcoding a secret into the repo.
 *
 * Resolution order (first hit wins):
 *   1. $OPTIMIZE_SKILL_JEV_CREDS      (path override, JSON file)
 *   2. <cwd>/.optimize-skill/jev.json (project-local, gitignored)
 *   3. ~/.config/optimize-skill/jev.json (per-machine)
 *   4. Environment variables: OPENROUTER_API_KEY -> openrouter, TYPESAFE_API_KEY -> typesafe
 *
 * If nothing is found it prints a machine-readable {"status":"need_credentials", ...} object
 * so the SKILL can turn it into an AskUserQuestion. Any real resolution prints
 * {"status":"ok","provider":...,"source":...} and (unless --show-key) redacts the key.
 *
 * Usage:
 *   bun resolve-jev-credentials.ts            # human/agent-facing status (key redacted)
 *   bun resolve-jev-credentials.ts --json     # same, machine-readable
 *   import { resolveJevCredentials } from "./resolve-jev-credentials.ts"  # programmatic
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";

export type JevProvider = "openrouter" | "typesafe";

export interface JevCredentials {
  provider: JevProvider;
  key: string;
  /** Optional model override, e.g. "typesafe/jev-1.13" or "~typesafe/jev-latest". */
  model?: string;
  /** Where the credential came from (for diagnostics). */
  source?: string;
}

export interface NeedCredentials {
  status: "need_credentials";
  message: string;
  /** Where the resolver looked, so the user knows where to place the file. */
  searched: string[];
  /** Shape the SKILL should ask the user to provide. */
  expected: { provider: "openrouter | typesafe"; key: "string"; model?: "string (optional)" };
  /** Preferred place to write the answer. */
  writeTo: string;
}

const CONFIG_FILENAME = "jev.json";

function machineConfigPath(): string {
  return join(homedir(), ".config", "optimize-skill", CONFIG_FILENAME);
}

function projectConfigPath(cwd: string): string {
  return join(cwd, ".optimize-skill", CONFIG_FILENAME);
}

function tryReadFile(path: string): JevCredentials | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (raw && typeof raw.key === "string" && (raw.provider === "openrouter" || raw.provider === "typesafe")) {
      return { provider: raw.provider, key: raw.key, model: raw.model, source: path };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve Jev credentials, or return a NeedCredentials descriptor.
 * @param cwd project directory to check for a project-local credential file.
 */
export function resolveJevCredentials(cwd: string = process.cwd()): JevCredentials | NeedCredentials {
  const searched: string[] = [];

  const override = process.env.OPTIMIZE_SKILL_JEV_CREDS;
  if (override) {
    searched.push(override);
    const c = tryReadFile(override);
    if (c) return c;
  }

  const projPath = projectConfigPath(cwd);
  searched.push(projPath);
  const proj = tryReadFile(projPath);
  if (proj) return proj;

  const machinePath = machineConfigPath();
  searched.push(machinePath);
  const machine = tryReadFile(machinePath);
  if (machine) return machine;

  searched.push("$OPENROUTER_API_KEY", "$TYPESAFE_API_KEY");
  if (process.env.OPENROUTER_API_KEY) {
    return { provider: "openrouter", key: process.env.OPENROUTER_API_KEY, source: "env:OPENROUTER_API_KEY" };
  }
  if (process.env.TYPESAFE_API_KEY) {
    return { provider: "typesafe", key: process.env.TYPESAFE_API_KEY, source: "env:TYPESAFE_API_KEY" };
  }

  return {
    status: "need_credentials",
    message:
      "No Jev credentials found. Ask the user which provider + key to use for Jev, then write it to the path below.",
    searched,
    expected: { provider: "openrouter | typesafe", key: "string", model: "string (optional)" },
    writeTo: machineConfigPath(),
  };
}

function redact(key: string): string {
  if (key.length <= 10) return "****";
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

// CLI entrypoint
if (import.meta.main) {
  const showKey = process.argv.includes("--show-key");
  const result = resolveJevCredentials();
  if ("status" in result) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(2); // non-zero so callers can branch on "need credentials"
  } else {
    console.log(
      JSON.stringify(
        { status: "ok", provider: result.provider, model: result.model ?? null, source: result.source, key: showKey ? result.key : redact(result.key) },
        null,
        2,
      ),
    );
  }
}
