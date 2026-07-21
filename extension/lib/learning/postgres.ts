/**
 * Postgres adapter — tsvector + GIN for cross-session recall.
 *
 * Works with Supabase, Neon, RDS, Vercel Postgres, or self-hosted PG.
 * Requires `pg`. Reads DATABASE_URL (or POSTGRES_URL). For Supabase serverless,
 * use the connection *pooler* URL (port 6543, transaction mode). TLS is on by
 * default; set `sslmode=disable` in the URL for a local plaintext PG.
 */

import pg from "pg";

import {
  BUDGETS,
  computeUsage,
  newId,
  nowIso,
  pickUnique,
  settings,
  unsafeMemoryReason,
  usageInfo,
  type CuratorMeta,
  type LearningStore,
  type MemoryEntry,
  type MemoryScope,
  type MemoryWriteResult,
  type MessageHit,
  type SkillRecord,
  type SkillState,
  type SkillWriteResult,
} from "./store";

const DDL = `
CREATE TABLE IF NOT EXISTS memories (
  id text PRIMARY KEY,
  owner_key text NOT NULL,
  scope text NOT NULL,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memories_owner ON memories (owner_key, scope, created_at);

CREATE TABLE IF NOT EXISTS skills (
  owner_key text NOT NULL,
  name text NOT NULL,
  description text NOT NULL,
  markdown text NOT NULL,
  category text,
  state text NOT NULL DEFAULT 'active',
  pinned boolean NOT NULL DEFAULT false,
  use_count integer NOT NULL DEFAULT 0,
  view_count integer NOT NULL DEFAULT 0,
  patch_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  PRIMARY KEY (owner_key, name)
);

CREATE TABLE IF NOT EXISTS messages (
  id text PRIMARY KEY,
  owner_key text NOT NULL,
  session_id text NOT NULL,
  role text NOT NULL,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
);
CREATE INDEX IF NOT EXISTS messages_tsv ON messages USING gin (tsv);
CREATE INDEX IF NOT EXISTS messages_owner ON messages (owner_key, session_id);

CREATE TABLE IF NOT EXISTS curator_meta (
  owner_key text PRIMARY KEY,
  last_run_at timestamptz,
  last_activity_at timestamptz
);

CREATE TABLE IF NOT EXISTS skill_snapshots (
  id text PRIMARY KEY,
  owner_key text NOT NULL,
  reason text,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
`;

const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
const isoReq = (v: unknown): string => iso(v) ?? "";

function rowToSkill(r: Record<string, unknown>): SkillRecord {
  return {
    name: String(r.name),
    description: String(r.description),
    markdown: String(r.markdown),
    category: (r.category as string | null) ?? null,
    state: String(r.state) as SkillState,
    pinned: Boolean(r.pinned),
    useCount: Number(r.use_count ?? 0),
    viewCount: Number(r.view_count ?? 0),
    patchCount: Number(r.patch_count ?? 0),
    createdAt: isoReq(r.created_at),
    updatedAt: isoReq(r.updated_at),
    lastUsedAt: iso(r.last_used_at),
  };
}

export class PostgresStore implements LearningStore {
  private pool: pg.Pool;
  private ready?: Promise<void>;

  constructor() {
    const cs = settings().databaseUrl;
    if (!cs) throw new Error("Postgres store selected but no URL set (config.databaseUrl or DATABASE_URL / POSTGRES_URL).");
    const ssl = /sslmode=disable/i.test(cs) ? false : { rejectUnauthorized: false };
    this.pool = new pg.Pool({ connectionString: cs, max: 3, ssl });
  }

  async init(): Promise<void> {
    return (this.ready ??= this.pool.query(DDL).then(() => undefined));
  }

  private async q<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const res = await this.pool.query<T>(text, params);
    return res.rows;
  }

  // ---- memory ----

  async listMemory(owner: string, scope: MemoryScope): Promise<MemoryEntry[]> {
    const rows = await this.q(
      "SELECT id, scope, content, created_at, updated_at FROM memories WHERE owner_key = $1 AND scope = $2 ORDER BY created_at",
      [owner, scope],
    );
    return rows.map((r) => ({
      id: String(r.id),
      scope: String(r.scope) as MemoryScope,
      content: String(r.content),
      createdAt: isoReq(r.created_at),
      updatedAt: isoReq(r.updated_at),
    }));
  }

  async addMemory(owner: string, scope: MemoryScope, content: string): Promise<MemoryWriteResult> {
    const entries = await this.listMemory(owner, scope);
    const reason = unsafeMemoryReason(content);
    if (reason)
      return { ok: false, action: "add", scope, usage: usageInfo(entries, scope), error: `Rejected: ${reason}.` };
    if (entries.some((e) => e.content === content))
      return { ok: true, action: "add", scope, usage: usageInfo(entries, scope), note: "Duplicate — no entry added." };

    const used = computeUsage(entries);
    if (used + content.length > BUDGETS[scope]) {
      return {
        ok: false,
        action: "add",
        scope,
        usage: usageInfo(entries, scope),
        entries: entries.map((e) => e.content),
        error:
          `Memory at ${used}/${BUDGETS[scope]} chars. Adding this entry (${content.length} chars) would exceed the limit. ` +
          "Consolidate now: 'replace' to merge overlapping entries, or 'remove' stale ones, then retry — all in this turn.",
      };
    }
    const ts = nowIso();
    await this.q(
      "INSERT INTO memories (id, owner_key, scope, content, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5)",
      [newId(), owner, scope, content, ts],
    );
    return { ok: true, action: "add", scope, usage: usageInfo([...entries, { content }], scope) };
  }

  async replaceMemory(
    owner: string,
    scope: MemoryScope,
    oldText: string,
    content: string,
  ): Promise<MemoryWriteResult> {
    const entries = await this.listMemory(owner, scope);
    const { entry, error } = pickUnique(entries, oldText);
    if (error) return { ok: false, action: "replace", scope, usage: usageInfo(entries, scope), error };
    const reason = unsafeMemoryReason(content);
    if (reason)
      return { ok: false, action: "replace", scope, usage: usageInfo(entries, scope), error: `Rejected: ${reason}.` };

    const after = entries.map((e) => (e.id === entry!.id ? { content } : { content: e.content }));
    if (computeUsage(after) > BUDGETS[scope]) {
      return {
        ok: false,
        action: "replace",
        scope,
        usage: usageInfo(entries, scope),
        entries: entries.map((e) => e.content),
        error: "Replacement would exceed the limit. Shorten the new content or remove another entry, then retry.",
      };
    }
    await this.q("UPDATE memories SET content = $1, updated_at = $2 WHERE id = $3", [content, nowIso(), entry!.id]);
    return { ok: true, action: "replace", scope, usage: usageInfo(after, scope) };
  }

  async removeMemory(owner: string, scope: MemoryScope, oldText: string): Promise<MemoryWriteResult> {
    const entries = await this.listMemory(owner, scope);
    const { entry, error } = pickUnique(entries, oldText);
    if (error) return { ok: false, action: "remove", scope, usage: usageInfo(entries, scope), error };
    await this.q("DELETE FROM memories WHERE id = $1", [entry!.id]);
    return { ok: true, action: "remove", scope, usage: usageInfo(entries.filter((e) => e.id !== entry!.id), scope) };
  }

  // ---- skills ----

  async listSkills(owner: string, opts?: { states?: SkillState[]; limit?: number }): Promise<SkillRecord[]> {
    const states = opts?.states ?? (["active", "stale", "archived"] as SkillState[]);
    const rows = await this.q(
      "SELECT * FROM skills WHERE owner_key = $1 AND state = ANY($2) ORDER BY updated_at DESC LIMIT $3",
      [owner, states, opts?.limit ?? 200],
    );
    return rows.map((r) => rowToSkill(r));
  }

  async getSkill(owner: string, name: string): Promise<SkillRecord | null> {
    const rows = await this.q("SELECT * FROM skills WHERE owner_key = $1 AND name = $2", [owner, name]);
    return rows[0] ? rowToSkill(rows[0]) : null;
  }

  async createSkill(
    owner: string,
    rec: { name: string; description: string; markdown: string; category?: string },
  ): Promise<SkillWriteResult> {
    if (await this.getSkill(owner, rec.name))
      return { ok: false, action: "create", name: rec.name, error: `Skill "${rec.name}" already exists; use patch/edit.` };
    const ts = nowIso();
    await this.q(
      "INSERT INTO skills (owner_key, name, description, markdown, category, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $6)",
      [owner, rec.name, rec.description, rec.markdown, rec.category ?? null, ts],
    );
    return { ok: true, action: "create", name: rec.name, note: "Saved. Loadable as a skill from your next session." };
  }

  async editSkill(
    owner: string,
    name: string,
    patch: { markdown?: string; description?: string; category?: string },
  ): Promise<SkillWriteResult> {
    const cur = await this.getSkill(owner, name);
    if (!cur) return { ok: false, action: "edit", name, error: `Skill "${name}" not found.` };
    await this.q(
      "UPDATE skills SET markdown = $1, description = $2, category = $3, updated_at = now(), last_used_at = now(), patch_count = patch_count + 1 WHERE owner_key = $4 AND name = $5",
      [patch.markdown ?? cur.markdown, patch.description ?? cur.description, patch.category ?? cur.category ?? null, owner, name],
    );
    return { ok: true, action: "edit", name };
  }

  async patchSkill(owner: string, name: string, oldString: string, newString: string): Promise<SkillWriteResult> {
    const cur = await this.getSkill(owner, name);
    if (!cur) return { ok: false, action: "patch", name, error: `Skill "${name}" not found.` };
    const occurrences = cur.markdown.split(oldString).length - 1;
    if (occurrences === 0) return { ok: false, action: "patch", name, error: "old_string not found in skill body." };
    if (occurrences > 1)
      return { ok: false, action: "patch", name, error: `old_string occurs ${occurrences} times; make it unique.` };
    await this.q(
      "UPDATE skills SET markdown = $1, updated_at = now(), last_used_at = now(), patch_count = patch_count + 1 WHERE owner_key = $2 AND name = $3",
      [cur.markdown.replace(oldString, newString), owner, name],
    );
    return { ok: true, action: "patch", name };
  }

  async deleteSkill(owner: string, name: string): Promise<SkillWriteResult> {
    const cur = await this.getSkill(owner, name);
    if (!cur) return { ok: false, action: "delete", name, error: `Skill "${name}" not found.` };
    if (cur.pinned) return { ok: false, action: "delete", name, error: `Skill "${name}" is pinned; unpin before deleting.` };
    await this.q("DELETE FROM skills WHERE owner_key = $1 AND name = $2", [owner, name]);
    return { ok: true, action: "delete", name };
  }

  async setPinned(owner: string, name: string, pinned: boolean): Promise<SkillWriteResult> {
    const cur = await this.getSkill(owner, name);
    if (!cur) return { ok: false, action: "pin", name, error: `Skill "${name}" not found.` };
    await this.q("UPDATE skills SET pinned = $1 WHERE owner_key = $2 AND name = $3", [pinned, owner, name]);
    return { ok: true, action: pinned ? "pin" : "unpin", name };
  }

  async recordSkillUse(owner: string, name: string): Promise<void> {
    await this.q("UPDATE skills SET use_count = use_count + 1, last_used_at = now() WHERE owner_key = $1 AND name = $2", [
      owner,
      name,
    ]);
  }

  async transitionSkills(
    owner: string,
    staleAfterDays: number,
    archiveAfterDays: number,
  ): Promise<{ staled: number; archived: number }> {
    // Age off whichever is later: last successful load or last edit.
    const archived = await this.pool.query(
      `UPDATE skills SET state = 'archived'
        WHERE owner_key = $1 AND pinned = false AND state <> 'archived'
          AND GREATEST(COALESCE(last_used_at, updated_at), updated_at) < now() - ($2 || ' days')::interval`,
      [owner, archiveAfterDays],
    );
    const staled = await this.pool.query(
      `UPDATE skills SET state = 'stale'
        WHERE owner_key = $1 AND pinned = false AND state = 'active'
          AND GREATEST(COALESCE(last_used_at, updated_at), updated_at) < now() - ($2 || ' days')::interval`,
      [owner, staleAfterDays],
    );
    return { staled: staled.rowCount ?? 0, archived: archived.rowCount ?? 0 };
  }

  // ---- transcript + FTS ----

  async recordMessage(owner: string, sessionId: string, role: string, content: string): Promise<void> {
    if (!content) return;
    await this.q("INSERT INTO messages (id, owner_key, session_id, role, content) VALUES ($1, $2, $3, $4, $5)", [
      newId(),
      owner,
      sessionId,
      role,
      content,
    ]);
  }

  async search(owner: string, query: string, limit: number): Promise<MessageHit[]> {
    const rows = await this.q(
      `SELECT session_id, role, content, created_at,
              ts_rank(tsv, websearch_to_tsquery('english', $2)) AS score,
              ts_headline('english', content, websearch_to_tsquery('english', $2),
                          'StartSel=«, StopSel=», MaxFragments=1, MaxWords=14, MinWords=4') AS snip
         FROM messages
        WHERE owner_key = $1 AND tsv @@ websearch_to_tsquery('english', $2)
        ORDER BY score DESC
        LIMIT $3`,
      [owner, query, limit],
    );
    return rows.map((r) => ({
      sessionId: String(r.session_id),
      role: String(r.role),
      content: String(r.content),
      snippet: String(r.snip),
      createdAt: isoReq(r.created_at),
      score: Number(r.score),
    }));
  }

  // ---- curator bookkeeping ----

  async listOwners(): Promise<string[]> {
    const rows = await this.q("SELECT DISTINCT owner_key FROM skills");
    return rows.map((r) => String(r.owner_key));
  }

  async touchActivity(owner: string): Promise<void> {
    await this.q(
      "INSERT INTO curator_meta (owner_key, last_activity_at) VALUES ($1, now()) " +
        "ON CONFLICT (owner_key) DO UPDATE SET last_activity_at = now()",
      [owner],
    );
  }

  async getCuratorMeta(owner: string): Promise<CuratorMeta> {
    const rows = await this.q("SELECT last_run_at, last_activity_at FROM curator_meta WHERE owner_key = $1", [owner]);
    const r = rows[0];
    return { lastRunAt: r ? iso(r.last_run_at) : null, lastActivityAt: r ? iso(r.last_activity_at) : null };
  }

  async setCuratorRun(owner: string, at: string): Promise<void> {
    await this.q(
      "INSERT INTO curator_meta (owner_key, last_run_at) VALUES ($1, $2) " +
        "ON CONFLICT (owner_key) DO UPDATE SET last_run_at = excluded.last_run_at",
      [owner, at],
    );
  }

  async snapshotSkills(owner: string, reason: string, keep: number): Promise<void> {
    const skills = await this.listSkills(owner);
    await this.q("INSERT INTO skill_snapshots (id, owner_key, reason, payload) VALUES ($1, $2, $3, $4)", [
      newId(),
      owner,
      reason,
      JSON.stringify(skills),
    ]);
    await this.q(
      "DELETE FROM skill_snapshots WHERE owner_key = $1 AND id NOT IN " +
        "(SELECT id FROM skill_snapshots WHERE owner_key = $1 ORDER BY created_at DESC LIMIT $2)",
      [owner, keep],
    );
  }
}
