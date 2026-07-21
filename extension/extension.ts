/**
 * eve-learning-loop — extension declaration.
 *
 * All config is optional: anything omitted falls back to environment variables
 * (see lib/learning/store.ts `settings()`), so the extension also works with a
 * bare re-export mount and env-only configuration. Env-only is REQUIRED for the
 * copy-in curator schedules, which run in the consuming agent outside this
 * extension's config scope — see templates/agent/schedules/ and the README.
 */

import { defineExtension } from "eve/extension";
import { z } from "zod";

export default defineExtension({
  config: z.object({
    /** "turso" | "postgres". Omit to infer from tursoDatabaseUrl / databaseUrl / env. */
    store: z.enum(["turso", "postgres"]).optional(),
    /** libsql://… or file:… — Turso/libSQL backend. Falls back to TURSO_DATABASE_URL. */
    tursoDatabaseUrl: z.string().optional(),
    /** Falls back to TURSO_AUTH_TOKEN. Not needed for file: URLs. */
    tursoAuthToken: z.string().optional(),
    /** postgres://… — Postgres backend (Supabase/Neon/RDS/…). Falls back to DATABASE_URL / POSTGRES_URL. */
    databaseUrl: z.string().optional(),
    /** Max learned skills surfaced per session. Default 60. */
    skillLimit: z.number().int().min(1).max(200).optional(),
    /**
     * MUST match your mount filename under agent/extensions/ (the namespace).
     * Only used to render exact tool names ("learning__memory") in the injected
     * behavioral guide so the model calls the right tools. Default "learning".
     */
    namespace: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/).default("learning"),
  }),
});
