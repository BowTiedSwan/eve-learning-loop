/**
 * COPY-IN TEMPLATE — place at agent/schedules/learning-curator.ts in your agent.
 *
 * Eve extensions cannot declare schedules (they run under the consuming agent's
 * deployment and limits), so the curator ships as this template. It talks to the
 * same database as the mounted extension via the package's /store subpath.
 *
 * IMPORTANT: schedules run outside the extension's config scope, so the store
 * resolves from ENV VARS here. Set LEARNING_STORE / TURSO_DATABASE_URL /
 * DATABASE_URL in the deployment even if you also pass config at the mount site.
 *
 * What it does (deterministic, no model tokens): per owner, gated on interval +
 * idle time, it snapshots the skill set and ages skills by time since last use
 * (successful `load_skill`, tracked by the extension's capture hook) or last
 * edit, whichever is later — active→stale→archived. Never deletes; skips pinned.
 *
 * Tunables (env): CURATOR_INTERVAL_HOURS (168), CURATOR_MIN_IDLE_HOURS (2),
 * CURATOR_STALE_DAYS (30), CURATOR_ARCHIVE_DAYS (90), CURATOR_KEEP_SNAPSHOTS (5).
 */

import { defineSchedule } from "eve/schedules";

import { getStore } from "eve-learning-loop/store";

const HOURS = 3_600_000;
const num = (key: string, fallback: number) => Number(process.env[key] ?? fallback);

export default defineSchedule({
  cron: "0 3 * * *", // daily 03:00 UTC; per-owner gating decides whether work actually runs
  async run() {
    const store = await getStore();
    const intervalMs = num("CURATOR_INTERVAL_HOURS", 168) * HOURS;
    const minIdleMs = num("CURATOR_MIN_IDLE_HOURS", 2) * HOURS;
    const staleDays = num("CURATOR_STALE_DAYS", 30);
    const archiveDays = num("CURATOR_ARCHIVE_DAYS", 90);
    const keep = num("CURATOR_KEEP_SNAPSHOTS", 5);
    const now = Date.now();

    for (const owner of await store.listOwners()) {
      const meta = await store.getCuratorMeta(owner);
      const sinceRun = meta.lastRunAt ? now - Date.parse(meta.lastRunAt) : Infinity;
      const sinceActivity = meta.lastActivityAt ? now - Date.parse(meta.lastActivityAt) : Infinity;
      if (sinceRun < intervalMs || sinceActivity < minIdleMs) continue;

      await store.snapshotSkills(owner, "curator-sweep", keep);
      await store.transitionSkills(owner, staleDays, archiveDays);
      await store.setCuratorRun(owner, new Date().toISOString());
    }
  },
});
