/**
 * Renders the bounded memory snapshot injected into the system prompt.
 * Mirrors the Hermes layout: a header with usage %, entries split by `§`.
 */

import { BUDGETS, computeUsage, type MemoryEntry, type MemoryScope } from "./store";

const RULE = "═".repeat(48);

const TITLES: Record<MemoryScope, string> = {
  agent: "MEMORY (your personal notes)",
  user: "USER PROFILE (about the person you're helping)",
};

/** One store's block, or "" when empty so empty stores add nothing to the prompt. */
export function renderMemoryBlock(scope: MemoryScope, entries: MemoryEntry[]): string {
  if (entries.length === 0) return "";
  const used = computeUsage(entries);
  const limit = BUDGETS[scope];
  const pct = Math.round((used / limit) * 100);
  const body = entries.map((e) => e.content).join("\n§\n");
  return [
    RULE,
    `${TITLES[scope]} [${pct}% — ${used}/${limit} chars]`,
    RULE,
    body,
  ].join("\n");
}

/** Both stores plus a short behavioral guide, as one system-message body. `ns` is the mount namespace. */
export function renderMemorySystemMessage(agent: MemoryEntry[], user: MemoryEntry[], ns = "learning"): string {
  const blocks = [renderMemoryBlock("agent", agent), renderMemoryBlock("user", user)].filter(Boolean);
  const memory = blocks.length > 0 ? blocks.join("\n\n") : "(memory is empty — nothing learned yet)";
  return [
    memory,
    "",
    "## Keeping memory and skills useful",
    `- This snapshot is frozen for the session. Writes via the \`${ns}__memory\` tool persist immediately but only re-appear here next session; the tool's response shows live state.`,
    `- Proactively save durable facts with \`${ns}__memory\` — user preferences and identity → target \`user\`; environment facts, conventions, and lessons learned → target \`memory\`. Skip trivia and anything easily re-discovered.`,
    `- When you work out a non-trivial, reusable workflow (5+ steps, a recovered dead-end, or a correction the user gave you), save it with \`${ns}__skill_manage\` (\`create\`). Refine an existing skill with \`patch\` as pitfalls come up. Newly saved skills become loadable next session.`,
    `- To recall specifics from past conversations, use \`${ns}__session_search\` rather than guessing.`,
  ].join("\n");
}
