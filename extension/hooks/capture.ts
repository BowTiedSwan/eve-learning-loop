/**
 * Capture hook — the "write" half of the learning loop.
 *
 * Three observe-only subscriptions:
 *  - `message.received` / `message.completed`: mirror every user and assistant
 *    message into the store's full-text index so `session_search` can recall
 *    them across sessions, and stamp activity for the curator's idle gate.
 *  - `actions.requested` / `action.result`: count successful `load_skill`
 *    calls against learned skills (`use_count` + `last_used_at`), so the
 *    curator can age skills by real usage instead of last-edit time. Skill
 *    loads surface on the stream as first-class `load-skill` runtime actions.
 *
 * Every handler is best-effort: a thrown hook fails the user's turn
 * (`turn.failed`), so persistence errors are logged and swallowed — a store
 * hiccup must never degrade the session.
 */

import { defineHook } from "eve/hooks";

import { getStore, ownerKey, settings } from "../lib/learning/store";

/** callId → requested skill name, for results that omit `name`. Bounded. */
const pendingLoads = new Map<string, string>();
const PENDING_CAP = 256;

function rememberLoad(callId: string, skill: string): void {
  if (pendingLoads.size >= PENDING_CAP) {
    const oldest = pendingLoads.keys().next().value;
    if (oldest !== undefined) pendingLoads.delete(oldest);
  }
  pendingLoads.set(callId, skill);
}

/** Strip this mount's namespace prefix ("learning__foo" → "foo"). */
function bareSkillName(runtimeName: string): string {
  const prefix = `${settings().namespace}__`;
  return runtimeName.startsWith(prefix) ? runtimeName.slice(prefix.length) : runtimeName;
}

function warn(where: string, error: unknown): void {
  console.warn(`[eve-learning-loop] ${where} failed (ignored):`, error);
}

export default defineHook({
  events: {
    async "message.received"(event, ctx) {
      try {
        const store = await getStore();
        const owner = ownerKey(ctx.session.auth);
        await store.recordMessage(owner, ctx.session.id, "user", event.data.message);
        await store.touchActivity(owner);
      } catch (error) {
        warn("message.received capture", error);
      }
    },

    async "message.completed"(event, ctx) {
      // `message` is null for tool-call-only steps; record only real assistant text.
      if (!event.data.message) return;
      try {
        const store = await getStore();
        await store.recordMessage(ownerKey(ctx.session.auth), ctx.session.id, "assistant", event.data.message);
      } catch (error) {
        warn("message.completed capture", error);
      }
    },

    "actions.requested"(event) {
      for (const action of event.data.actions) {
        if (action.kind === "load-skill" && typeof action.input.skill === "string") {
          rememberLoad(action.callId, action.input.skill);
        }
      }
    },

    async "action.result"(event, ctx) {
      const { result, status } = event.data;
      if (result.kind !== "load-skill-result") return;
      const requested = pendingLoads.get(result.callId);
      pendingLoads.delete(result.callId);
      if (status !== "completed" || result.isError === true) return;
      const name = result.name ?? requested;
      if (!name) return;
      try {
        const store = await getStore();
        // No-op for framework/static skills: the UPDATE matches no learned row.
        await store.recordSkillUse(ownerKey(ctx.session.auth), bareSkillName(name));
      } catch (error) {
        warn("skill-use capture", error);
      }
    },
  },
});
