/**
 * Dynamic instructions — the "read" half of memory.
 *
 * On session start, loads the bounded MEMORY/USER stores and injects them as a
 * single system message, exactly like Hermes's frozen-snapshot pattern: the
 * snapshot is captured once per session (so the prefix cache stays stable and
 * mid-session writes only re-appear next session). Switch the event to
 * `turn.started` if you want the snapshot to refresh every turn at some cache cost.
 */

import { defineDynamic } from "eve/tools";
import { defineInstructions } from "eve/instructions";

import { getStore, ownerKey, settings } from "../lib/learning/store";
import { renderMemorySystemMessage } from "../lib/learning/render";

export default defineDynamic({
  events: {
    "session.started": async (_event, ctx) => {
      const store = await getStore();
      const owner = ownerKey(ctx.session.auth);
      const [agent, user] = await Promise.all([store.listMemory(owner, "agent"), store.listMemory(owner, "user")]);
      return defineInstructions({ markdown: renderMemorySystemMessage(agent, user, settings().namespace) });
    },
  },
});
