# @bowtiedswan/eve-learning-loop

A Hermes-style **self-improving loop** for [Vercel Eve](https://github.com/vercel/eve) agents, packaged as a mountable Eve extension:

- **Bounded cross-session memory** — a character-budgeted agent notebook + user profile, injected as a frozen snapshot each session, curated by the agent itself through a `memory` tool.
- **Agent-authored skills** — the agent writes reusable procedures with `skill_manage`; they resurface next session as **native, load-on-demand skills** under your mount namespace.
- **Full-text session recall** — every message is indexed; `session_search` returns ranked snippets from past conversations.
- **Curator lifecycle** — deterministic aging (active→stale→archived, never deletes, pin to protect, snapshots for rollback) plus an optional LLM consolidation pass.
- **Real usage telemetry** — every successful `load_skill` of a learned skill is counted from the stream (`load-skill` runtime actions), so curation ages skills by when they were last *used*, not just last edited.

The store is **backend-pluggable**: **Turso/libSQL** (SQLite FTS5) or **Postgres** (tsvector + GIN — Supabase, Neon, RDS, Vercel Postgres, self-hosted). Bring your own database; no external memory service.

Not another fact-memory layer: existing Eve memory integrations remember *facts*. This extension also closes the *procedural* loop — the agent improves its own skill set over time.

## Install & mount

```sh
npm i @bowtiedswan/eve-learning-loop
```

Mount it under `agent/extensions/`. The file basename is the namespace (examples below use `learning`):

```ts
// agent/extensions/learning.ts
import learningLoop from "@bowtiedswan/eve-learning-loop";

export default learningLoop({
  // everything optional — anything omitted falls back to env vars
  store: "postgres",                       // or "turso"; inferred from URLs if omitted
  databaseUrl: process.env.DATABASE_URL,   // Postgres (Supabase/Neon/RDS/…)
  // tursoDatabaseUrl: process.env.TURSO_DATABASE_URL,
  // tursoAuthToken: process.env.TURSO_AUTH_TOKEN,
  // skillLimit: 60,
  namespace: "learning",                   // must match this file's basename
});
```

Env-only configuration also works (mount with a bare factory call `learningLoop({})`):

```sh
LEARNING_STORE=turso|postgres        # optional; inferred from which URL is set
TURSO_DATABASE_URL=libsql://…        # or file:.eve-learning.db locally
TURSO_AUTH_TOKEN=…                   # omit for file: URLs
DATABASE_URL=postgres://…            # or POSTGRES_URL
```

> **Set the env vars in your deployment even if you pass mount config** — the copy-in curator schedule (below) runs outside the extension's config scope and resolves from env.

Contributions compose under the namespace: tools `learning__memory`, `learning__skill_manage`, `learning__session_search`; the memory snapshot arrives via dynamic instructions; learned skills surface through the dynamic skill resolver. The injected snapshot includes a short behavioral guide with the exact tool names (rendered from `namespace`), so the base `instructions.md` needs no changes — though a one-line mention there reinforces usage.

## Curator schedules (copy-in)

Eve extensions cannot declare schedules, so the curator ships as templates. Copy both (or just the first) into your agent:

```sh
cp node_modules/@bowtiedswan/eve-learning-loop/templates/agent/schedules/*.ts agent/schedules/
```

- `learning-curator.ts` — deterministic sweep, no model tokens. Daily cron, per-owner gated on interval (default weekly) + idle time (2h). Snapshots skills, then ages them by time since last use or last edit, whichever is later. Never deletes; skips pinned. Tunables via `CURATOR_*` env vars (see file header).
- `learning-curator-review.ts` — optional weekly LLM pass that consolidates duplicates, patches drift, and archives obsolete skills via `skill_manage`. Costs tokens; delete the file to opt out. If your mount namespace isn't `learning`, update the tool names in its prompt.

The sweep imports the same store through the package's `@bowtiedswan/eve-learning-loop/store` subpath, so both halves see one database.

## Postgres notes

Works with any Postgres 12+. For **Supabase on serverless, use the pooler URL** (port 6543, transaction mode). TLS is on by default; append `?sslmode=disable` only for local plaintext PG. The pool is capped at 3 connections. Place your Vercel function region near the database.

## Turso notes

HTTP-based, serverless-native, no pooling concerns. `file:` URLs work for local dev.

## Schema

`getStore()` runs idempotent DDL on first use — no migrations to run. Tables: `memories`, `skills`, messages (FTS5 virtual table on Turso; `tsvector GENERATED` + GIN on Postgres), `curator_meta`, `skill_snapshots`. See the `DDL` constants in `extension/lib/learning/{turso,postgres}.ts`.

## Multi-tenant

Everything is scoped by owner = `ctx.session.auth.current?.principalId` (fallback `"local"`). Each principal gets isolated memory, skills, and transcripts. The sweep iterates all owners; the LLM review runs as the app principal over its own skills.

## Honest limitations

- **Skill-use capture is best-effort.** Loads are observed from `actions.requested` / `action.result` stream events (skill loads are first-class `load-skill` runtime actions); the hook swallows store errors rather than failing the turn, so `use_count` can undercount during database outages. Staleness uses the later of last-use and last-edit, so an undercount can only delay aging, never cause premature archival.
- **Memory is a prompt-injection surface** (it lands in the system prompt). `unsafeMemoryReason()` is a light guard (invisible unicode + exfiltration patterns), not a hardened filter. For adversarial settings, add a `needsApproval` gate on the memory tool via a [mount override](https://github.com/vercel/eve/blob/main/docs/extensions.md).
- **Both DB drivers are in `dependencies`** for v0.1 (correctness over bundle size — the unused one is never imported at runtime thanks to dynamic adapter loading, but it is installed). A later release may split drivers into subpackages.
- **Frozen-per-session snapshots**: mid-session memory writes and new skills appear next session. This is deliberate (prefix-cache stability, Hermes parity); resolve on `turn.started` instead if you want same-session freshness at some cache cost.

## Development

```sh
npm i
npm run build     # eve extension build → dist/extension + declarations + manifest
```

Under `eve dev` in a workspace, mounted workspace extensions hot-rebuild on source changes.
