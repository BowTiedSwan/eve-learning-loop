/**
 * `memory` tool — lets the agent curate its own bounded memory.
 *
 * Two stores: `memory` (the agent's own durable notes) and `user` (a profile of
 * the person). Both are character-budgeted; on overflow the tool returns the
 * current entries plus a usage readout so the model can consolidate and retry in
 * the same turn, instead of silently failing.
 */

import { defineTool } from "eve/tools";
import { z } from "zod";

import { getStore, ownerKey } from "../lib/learning/store";

export default defineTool({
  description:
    "Persist durable memory across sessions. action=add stores a new fact; action=replace swaps the single entry " +
    "containing `old_text` for `content`; action=remove deletes the entry containing `old_text`. target=memory is " +
    "your own notes (conventions, environment facts, lessons); target=user is a profile of the person (preferences, " +
    "identity, recurring goals). Keep entries atomic and durable; do not store trivia or secrets. Stores are " +
    "character-budgeted — if a write would overflow, you'll get the current entries back so you can consolidate.",
  inputSchema: z.object({
    action: z.enum(["add", "replace", "remove"]),
    target: z.enum(["memory", "user"]).default("memory"),
    content: z.string().optional().describe("New text for add/replace."),
    old_text: z.string().optional().describe("A short unique substring identifying the entry, for replace/remove."),
  }),
  async execute(input, ctx) {
    const store = await getStore();
    const owner = ownerKey(ctx.session.auth);
    const scope = input.target === "user" ? "user" : "agent";

    if (input.action === "add") {
      if (!input.content) return { ok: false, error: "`content` is required for add." };
      return store.addMemory(owner, scope, input.content);
    }
    if (input.action === "replace") {
      if (!input.old_text || !input.content)
        return { ok: false, error: "`old_text` and `content` are both required for replace." };
      return store.replaceMemory(owner, scope, input.old_text, input.content);
    }
    if (!input.old_text) return { ok: false, error: "`old_text` is required for remove." };
    return store.removeMemory(owner, scope, input.old_text);
  },
});
