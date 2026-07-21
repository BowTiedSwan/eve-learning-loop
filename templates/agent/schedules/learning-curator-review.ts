/**
 * COPY-IN TEMPLATE — place at agent/schedules/learning-curator-review.ts.
 *
 * Optional LLM curation pass (costs model tokens). Fire-and-forget markdown
 * schedule: Eve runs the agent on this prompt and discards the output. The
 * mounted extension's dynamic resolvers fire for this session too, so the agent
 * sees its injected memory and its learned skills, and can use the extension's
 * skill_manage tool to consolidate duplicates, patch drift, and archive obsolete
 * skills — the judgement-based half the deterministic sweep can't do.
 *
 * Runs as the app principal, curating that principal's own skills. Skip this
 * file entirely to rely solely on the deterministic learning-curator sweep.
 *
 * NOTE: tool names below assume the extension is mounted as `learning`
 * (agent/extensions/learning.ts). If you mounted under a different namespace,
 * update the prompt to match.
 */

import { defineSchedule } from "eve/schedules";

export default defineSchedule({
  cron: "0 4 * * 0", // Sundays 04:00 UTC
  markdown: [
    "Curate your learned skills. Review the learned skills available to you (contributed by the `learning` extension) and:",
    "1. Load any whose descriptions overlap and merge them into one canonical skill with `learning__skill_manage` (action `edit`), then delete the redundant ones.",
    "2. Patch skills whose steps look stale or that you've since found pitfalls for (`learning__skill_manage`, action `patch`).",
    "3. Delete skills that are clearly obsolete or were never useful (skip pinned ones — they're protected).",
    "Be conservative: when unsure, keep the skill. Make only changes you're confident improve future runs.",
  ].join("\n"),
});
