/**
 * jev-probe.ts
 *
 * One-shot live probe to confirm the Jev decisions API envelope for the resolved provider.
 * Sends one Choice, one Noul, and one Score question and prints BOTH the raw provider
 * response and the normalized answers, so we can lock jev-client.ts against reality.
 *
 * Usage: bun jev-probe.ts
 */

import { resolveJevCredentials } from "./resolve-jev-credentials.ts";
import { JevClient, JevError, choice, noul, score } from "./jev-client.ts";

async function main() {
  const creds = resolveJevCredentials();
  if ("status" in creds) {
    console.error(JSON.stringify(creds, null, 2));
    process.exit(2);
  }
  console.log(`Provider: ${creds.provider}  Model: ${creds.model ?? "(default)"}  Source: ${creds.source}`);

  const client = new JevClient(creds);
  const input = {
    state: { content: "The navbar flickers in Safari after opening the profile menu. Happens every time." },
    questions: {
      issueType: choice("Classify this software work item.", {
        bug: "Something is broken or behaving incorrectly",
        feature: "A new capability that does not exist yet",
        improvement: "Enhancing something that already works",
        maintenance: "Refactors, deps, chores, tech debt",
      }),
      contextSufficient: noul("There is enough detail here to write a clear issue without asking the user more questions."),
      needsCodeInvestigation: noul("Investigating the codebase would materially improve this issue."),
      severity: score("How severe is this for users?", [
        "Cosmetic / minor annoyance",
        "Noticeable but has a workaround",
        "Blocks a core workflow",
      ]),
    },
  } as const;

  try {
    // Also do a raw fetch so we can see the exact wire response the normalizer parsed.
    const res = await client.decisions(input);
    console.log("\n=== NORMALIZED ANSWERS ===");
    console.log(JSON.stringify(res, null, 2));
    console.log("\n=== RAW (per-answer) ===");
    for (const [k, v] of Object.entries(res.answers)) {
      console.log(k, "=>", JSON.stringify(v.raw));
    }
  } catch (e) {
    if (e instanceof JevError) {
      console.error(`\nJevError ${e.status}: ${e.message}\nBody: ${e.body}`);
      process.exit(1);
    }
    throw e;
  }
}

main();
