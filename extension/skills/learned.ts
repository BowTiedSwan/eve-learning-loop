/**
 * Dynamic skills — surfaces agent-authored skills from the store as native,
 * load-on-demand skills. Each active skill becomes `<namespace>__<name>` (e.g.
 * `learning__triage`), advertised by its description and pulled into context by
 * the framework `load_skill` tool, exactly like a static skill in `agent/skills/`.
 * The capture hook counts those loads back into the store (`use_count`).
 *
 * Resolved at session start (frozen per session for cache stability), so a skill
 * the agent creates mid-session becomes loadable from the next session. Add
 * `turn.started` here if you want same-session availability.
 */

import { defineDynamic, type DynamicResolveContext } from "eve/tools";
import { defineSkill } from "eve/skills";

import { getStore, ownerKey, settings } from "../lib/learning/store";

async function resolve(_event: unknown, ctx: DynamicResolveContext) {
  const store = await getStore();
  const skills = await store.listSkills(ownerKey(ctx.session.auth), { states: ["active"], limit: settings().skillLimit });
  if (skills.length === 0) return null;

  return Object.fromEntries(
    skills.map((s) => [
      s.name,
      defineSkill({
        description: s.description,
        markdown: s.markdown,
        metadata: { source: "agent-authored", category: s.category ?? "uncategorized" },
      }),
    ]),
  );
}

export default defineDynamic({
  events: {
    "session.started": resolve,
  },
});
