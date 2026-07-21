/**
 * Turso / libSQL adapter — SQLite FTS5 for cross-session recall.
 *
 * Works against Turso (HTTP, serverless-friendly) or a local file
 * (TURSO_DATABASE_URL="file:.eve-learning.db"). Requires `@libsql/client`.
 */

import { createClient, type Client, type InValue } from "@libsql/client";

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
  id TEXT PRIMARY KEY,
  owner_key TEXT NOT NULL,
  scope TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memories_owner ON memories (owner_key, scope, created_at);

CREATE TABLE IF NOT EXISTS skills (
  owner_key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  markdown TEXT NOT NULL,
  category TEXT,
  state TEXT NOT NULL DEFAULT 'active',
  pinned INTEGER NOT NULL DEFAULT 0,
  use_count INTEGER NOT NULL DEFAULT 0,
  view_count INTEGER NOT NULL DEFAULT 0,
  patch_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT,
  PRIMARY KEY (owner_key, name)
);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5 (
  content,
  owner_key UNINDEXED,
  session_id UNINDEXED,
  role UNINDEXED,
  created_at UNINDEXED,
  tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS curator_meta (
  owner_key TEXT PRIMARY KEY,
  last_run_at TEXT,
  last_activity_at TEXT
);

CREATE TABLE IF NOT EXISTS skill_snapshots (
  id TEXT PRIMARY KEY,
  owner_key TEXT NOT NULL,
  reason TEXT,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

function str(v: unknown): string {
  return v == null ? "" : String(v);
}

/** Turn a free-text query into a recall-friendly FTS5 MATCH expression. */
function toMatch(q: string): string {
  const toks = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (toks.length === 0) return '""';
  return toks.map((t) => `"${t}"`).join(" OR ");
}

function rowToSkill(r: Record<string, unknown>): SkillRecord {
  return {
    name: str(r.name),
    description: str(r.description),
    markdown: str(r.markdown),
    category: (r.category as string | null) ?? null,
    state: str(r.state) as SkillState,
    pinned: Number(r.pinned) === 1,
    useCount: Number(r.use_count ?? 0),
    viewCount: Number(r.view_count ?? 0),
    patchCount: Number(r.patch_count ?? 0),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
    lastUsedAt: (r.last_used_at as string | null) ?? null,
  };
}

export class TursoStore implements LearningStore {
  private client: Client;
  private ready?: Promise<void>;

  constructor() {
    const cfg = settings();
    const url = cfg.tursoDatabaseUrl;
    if (!url) throw new Error("Turso store selected but no URL set (config.tursoDatabaseUrl or TURSO_DATABASE_URL).");
    this.client = createClient({ url, authToken: cfg.tursoAuthToken });
  }

  init(): Promise<void> {
    return (this.ready ??= this.client.executeMultiple(DDL));
  }

  private q(sql: string, args: InValue[] = []) {
    return this.client.execute({ sql, args });
  }

  // ---- memory ----

  async listMemory(owner: string, scope: MemoryScope): Promise<MemoryEntry[]> {
    const { rows } = await this.q(
      "SELECT id, scope, content, created_at, updated_at FROM memories WHERE owner_key = ? AND scope = ? ORDER BY created_at",
      [owner, scope],
    );
    return rows.map((r) => ({
      id: str(r.id),
      scope: str(r.scope) as MemoryScope,
      content: str(r.content),
      createdAt: str(r.created_at),
      updatedAt: str(r.updated_at),
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
      "INSERT INTO memories (id, owner_key, scope, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      [newId(), owner, scope, content, ts, ts],
    );
    const after = [...entries, { content }];
    return { ok: true, action: "add", scope, usage: usageInfo(after, scope) };
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
    await this.q("UPDATE memories SET content = ?, updated_at = ? WHERE id = ?", [content, nowIso(), entry!.id]);
    return { ok: true, action: "replace", scope, usage: usageInfo(after, scope) };
  }

  async removeMemory(owner: string, scope: MemoryScope, oldText: string): Promise<MemoryWriteResult> {
    const entries = await this.listMemory(owner, scope);
    const { entry, error } = pickUnique(entries, oldText);
    if (error) return { ok: false, action: "remove", scope, usage: usageInfo(entries, scope), error };
    await this.q("DELETE FROM memories WHERE id = ?", [entry!.id]);
    const after = entries.filter((e) => e.id !== entry!.id);
    return { ok: true, action: "remove", scope, usage: usageInfo(after, scope) };
  }

  // ---- skills ----

  async listSkills(owner: string, opts?: { states?: SkillState[]; limit?: number }): Promise<SkillRecord[]> {
    const states = opts?.states ?? (["active", "stale", "archived"] as SkillState[]);
    const placeholders = states.map(() => "?").join(", ");
    const limit = opts?.limit ?? 200;
    const { rows } = await this.q(
      `SELECT * FROM skills WHERE owner_key = ? AND state IN (${placeholders}) ORDER BY updated_at DESC LIMIT ?`,
      [owner, ...states, limit],
    );
    return rows.map((r) => rowToSkill(r as Record<string, unknown>));
  }

  async getSkill(owner: string, name: string): Promise<SkillRecord | null> {
    const { rows } = await this.q("SELECT * FROM skills WHERE owner_key = ? AND name = ?", [owner, name]);
    return rows[0] ? rowToSkill(rows[0] as Record<string, unknown>) : null;
  }

  async createSkill(
    owner: string,
    rec: { name: string; description: string; markdown: string; category?: string },
  ): Promise<SkillWriteResult> {
    if (await this.getSkill(owner, rec.name))
      return { ok: false, action: "create", name: rec.name, error: `Skill "${rec.name}" already exists; use patch/edit.` };
    const ts = nowIso();
    await this.q(
      "INSERT INTO skills (owner_key, name, description, markdown, category, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [owner, rec.name, rec.description, rec.markdown, rec.category ?? null, ts, ts],
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
      "UPDATE skills SET markdown = ?, description = ?, category = ?, updated_at = ?, last_used_at = ?, patch_count = patch_count + 1 WHERE owner_key = ? AND name = ?",
      [
        patch.markdown ?? cur.markdown,
        patch.description ?? cur.description,
        patch.category ?? cur.category ?? null,
        nowIso(),
        nowIso(),
        owner,
        name,
      ],
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
    const next = cur.markdown.replace(oldString, newString);
    await this.q(
      "UPDATE skills SET markdown = ?, updated_at = ?, last_used_at = ?, patch_count = patch_count + 1 WHERE owner_key = ? AND name = ?",
      [next, nowIso(), nowIso(), owner, name],
    );
    return { ok: true, action: "patch", name };
  }

  async deleteSkill(owner: string, name: string): Promise<SkillWriteResult> {
    const cur = await this.getSkill(owner, name);
    if (!cur) return { ok: false, action: "delete", name, error: `Skill "${name}" not found.` };
    if (cur.pinned) return { ok: false, action: "delete", name, error: `Skill "${name}" is pinned; unpin before deleting.` };
    await this.q("DELETE FROM skills WHERE owner_key = ? AND name = ?", [owner, name]);
    return { ok: true, action: "delete", name };
  }

  async setPinned(owner: string, name: string, pinned: boolean): Promise<SkillWriteResult> {
    const cur = await this.getSkill(owner, name);
    if (!cur) return { ok: false, action: "pin", name, error: `Skill "${name}" not found.` };
    await this.q("UPDATE skills SET pinned = ? WHERE owner_key = ? AND name = ?", [pinned ? 1 : 0, owner, name]);
    return { ok: true, action: pinned ? "pin" : "unpin", name };
  }

  async recordSkillUse(owner: string, name: string): Promise<void> {
    await this.q(
      "UPDATE skills SET use_count = use_count + 1, last_used_at = ? WHERE owner_key = ? AND name = ?",
      [nowIso(), owner, name],
    );
  }

  async transitionSkills(
    owner: string,
    staleAfterDays: number,
    archiveAfterDays: number,
  ): Promise<{ staled: number; archived: number }> {
    const staleBefore = new Date(Date.now() - staleAfterDays * 86_400_000).toISOString();
    const archiveBefore = new Date(Date.now() - archiveAfterDays * 86_400_000).toISOString();
    // Age off whichever is later: last successful load or last edit. ISO-8601
    // strings compare correctly as text; COALESCE guards never-used skills.
    const archived = await this.q(
      "UPDATE skills SET state = 'archived' WHERE owner_key = ? AND pinned = 0 AND state != 'archived' AND max(coalesce(last_used_at, updated_at), updated_at) < ?",
      [owner, archiveBefore],
    );
    const staled = await this.q(
      "UPDATE skills SET state = 'stale' WHERE owner_key = ? AND pinned = 0 AND state = 'active' AND max(coalesce(last_used_at, updated_at), updated_at) < ?",
      [owner, staleBefore],
    );
    return { staled: staled.rowsAffected ?? 0, archived: archived.rowsAffected ?? 0 };
  }

  // ---- transcript + FTS ----

  async recordMessage(owner: string, sessionId: string, role: string, content: string): Promise<void> {
    if (!content) return;
    await this.q(
      "INSERT INTO messages_fts (content, owner_key, session_id, role, created_at) VALUES (?, ?, ?, ?, ?)",
      [content, owner, sessionId, role, nowIso()],
    );
  }

  async search(owner: string, query: string, limit: number): Promise<MessageHit[]> {
    const { rows } = await this.q(
      `SELECT content, session_id, role, created_at,
              bm25(messages_fts) AS score,
              snippet(messages_fts, 0, '«', '»', '…', 12) AS snip
         FROM messages_fts
        WHERE messages_fts MATCH ? AND owner_key = ?
        ORDER BY bm25(messages_fts)
        LIMIT ?`,
      [toMatch(query), owner, limit],
    );
    return rows.map((r) => ({
      sessionId: str(r.session_id),
      role: str(r.role),
      content: str(r.content),
      snippet: str(r.snip),
      createdAt: str(r.created_at),
      score: -Number(r.score), // bm25: lower is better → negate so higher = better
    }));
  }

  // ---- curator bookkeeping ----

  async listOwners(): Promise<string[]> {
    const { rows } = await this.q("SELECT DISTINCT owner_key FROM skills");
    return rows.map((r) => str(r.owner_key));
  }

  async touchActivity(owner: string): Promise<void> {
    await this.q(
      "INSERT INTO curator_meta (owner_key, last_activity_at) VALUES (?, ?) " +
        "ON CONFLICT(owner_key) DO UPDATE SET last_activity_at = excluded.last_activity_at",
      [owner, nowIso()],
    );
  }

  async getCuratorMeta(owner: string): Promise<CuratorMeta> {
    const { rows } = await this.q("SELECT last_run_at, last_activity_at FROM curator_meta WHERE owner_key = ?", [owner]);
    const r = rows[0];
    return {
      lastRunAt: r ? ((r.last_run_at as string | null) ?? null) : null,
      lastActivityAt: r ? ((r.last_activity_at as string | null) ?? null) : null,
    };
  }

  async setCuratorRun(owner: string, at: string): Promise<void> {
    await this.q(
      "INSERT INTO curator_meta (owner_key, last_run_at) VALUES (?, ?) " +
        "ON CONFLICT(owner_key) DO UPDATE SET last_run_at = excluded.last_run_at",
      [owner, at],
    );
  }

  async snapshotSkills(owner: string, reason: string, keep: number): Promise<void> {
    const skills = await this.listSkills(owner);
    await this.q("INSERT INTO skill_snapshots (id, owner_key, reason, payload, created_at) VALUES (?, ?, ?, ?, ?)", [
      newId(),
      owner,
      reason,
      JSON.stringify(skills),
      nowIso(),
    ]);
    await this.q(
      "DELETE FROM skill_snapshots WHERE owner_key = ? AND id NOT IN " +
        "(SELECT id FROM skill_snapshots WHERE owner_key = ? ORDER BY created_at DESC LIMIT ?)",
      [owner, owner, keep],
    );
  }
}
