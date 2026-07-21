/**
 * Learning-loop store: the single persistence surface the agent's memory,
 * skills, and session-search features read and write.
 *
 * Two interchangeable backends implement {@link LearningStore}:
 *   - Turso / libSQL  → SQLite FTS5            (./turso.ts)
 *   - Postgres        → tsvector + GIN          (./postgres.ts)  works with Supabase, Neon, RDS, Vercel Postgres
 *
 * Selection is by env (see {@link resolveBackend}); the chosen adapter is
 * dynamically imported so only its driver is pulled into the bundle.
 *
 * `defineState` (Eve's built-in state) is deliberately NOT used here: it is
 * session-scoped and dies with the conversation. Everything in this loop must
 * outlive the session and be shared across sessions, which Eve's own State doc
 * says belongs in an external store. That store is this.
 */

import extension from "../../extension";

export type MemoryScope = "agent" | "user";

/** Character budgets per memory store, mirroring Hermes (MEMORY.md / USER.md). */
export const BUDGETS: Record<MemoryScope, number> = { agent: 2200, user: 1375 };

export interface MemoryEntry {
  id: string;
  scope: MemoryScope;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface UsageInfo {
  used: number;
  limit: number;
  pct: number;
}

/** Result of a memory write, shaped so the model can self-correct on failure. */
export interface MemoryWriteResult {
  ok: boolean;
  action: "add" | "replace" | "remove";
  scope: MemoryScope;
  usage: UsageInfo;
  /** Present on failure: the exact entries currently stored, so the model can consolidate and retry in the same turn. */
  entries?: string[];
  error?: string;
  note?: string;
}

export type SkillState = "active" | "stale" | "archived";

export interface SkillRecord {
  name: string;
  description: string;
  markdown: string;
  category?: string | null;
  state: SkillState;
  pinned: boolean;
  useCount: number;
  viewCount: number;
  patchCount: number;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string | null;
}

export interface SkillWriteResult {
  ok: boolean;
  action: string;
  name: string;
  error?: string;
  note?: string;
}

export interface MessageHit {
  sessionId: string;
  role: string;
  content: string;
  snippet: string;
  createdAt: string;
  /** Relevance, higher = better, for both backends. */
  score: number;
}

export interface CuratorMeta {
  lastRunAt: string | null;
  lastActivityAt: string | null;
}

export interface LearningStore {
  /** Idempotently create tables / indexes / FTS structures. Memoized per process. */
  init(): Promise<void>;

  // ---- memory (MEMORY.md / USER.md equivalents) ----
  listMemory(owner: string, scope: MemoryScope): Promise<MemoryEntry[]>;
  addMemory(owner: string, scope: MemoryScope, content: string): Promise<MemoryWriteResult>;
  replaceMemory(
    owner: string,
    scope: MemoryScope,
    oldText: string,
    content: string,
  ): Promise<MemoryWriteResult>;
  removeMemory(owner: string, scope: MemoryScope, oldText: string): Promise<MemoryWriteResult>;

  // ---- skills (agent-authored procedural memory) ----
  listSkills(owner: string, opts?: { states?: SkillState[]; limit?: number }): Promise<SkillRecord[]>;
  getSkill(owner: string, name: string): Promise<SkillRecord | null>;
  createSkill(
    owner: string,
    rec: { name: string; description: string; markdown: string; category?: string },
  ): Promise<SkillWriteResult>;
  editSkill(
    owner: string,
    name: string,
    patch: { markdown?: string; description?: string; category?: string },
  ): Promise<SkillWriteResult>;
  patchSkill(owner: string, name: string, oldString: string, newString: string): Promise<SkillWriteResult>;
  deleteSkill(owner: string, name: string): Promise<SkillWriteResult>;
  setPinned(owner: string, name: string, pinned: boolean): Promise<SkillWriteResult>;
  /**
   * Count one successful `load_skill` of a learned skill: bumps `use_count`,
   * stamps `last_used_at`. No-op when `name` is not a learned skill of `owner`
   * (framework/static skill loads land here too and are ignored).
   */
  recordSkillUse(owner: string, name: string): Promise<void>;
  /** Deterministic curator phase: active→stale→archived by age since last use or edit (whichever is later). Never deletes. Skips pinned. */
  transitionSkills(
    owner: string,
    staleAfterDays: number,
    archiveAfterDays: number,
  ): Promise<{ staled: number; archived: number }>;

  // ---- session transcript + FTS recall ----
  recordMessage(owner: string, sessionId: string, role: string, content: string): Promise<void>;
  search(owner: string, query: string, limit: number): Promise<MessageHit[]>;

  // ---- curator bookkeeping ----
  listOwners(): Promise<string[]>;
  touchActivity(owner: string): Promise<void>;
  getCuratorMeta(owner: string): Promise<CuratorMeta>;
  setCuratorRun(owner: string, at: string): Promise<void>;
  /** Snapshot all skills for an owner (cheap rollback parity), pruning to `keep`. */
  snapshotSkills(owner: string, reason: string, keep: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// Backend selection + memoized singleton
// ---------------------------------------------------------------------------

export type Backend = "turso" | "postgres";

export interface Settings {
  backend?: Backend;
  tursoDatabaseUrl?: string;
  tursoAuthToken?: string;
  databaseUrl?: string;
  skillLimit: number;
  namespace: string;
}

/**
 * Resolves settings from the extension's bound config, falling back to env vars
 * for anything unset. Config binding is namespace-scoped and may be unavailable
 * outside the extension's own modules (e.g. in the consumer's copy-in curator
 * schedules, or before a mount evaluates) — the try/catch makes env vars the
 * universal fallback, so env-only configuration always works everywhere.
 */
export function settings(): Settings {
  let cfg: Record<string, unknown> = {};
  try {
    cfg = (extension.config as Record<string, unknown>) ?? {};
  } catch {
    cfg = {}; // config not bound in this context (e.g. consumer schedules) — env fallback below
  }
  const s = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
  const explicit = (s(cfg.store) ?? process.env.LEARNING_STORE)?.toLowerCase();
  return {
    backend: explicit === "turso" || explicit === "postgres" ? explicit : undefined,
    tursoDatabaseUrl: s(cfg.tursoDatabaseUrl) ?? process.env.TURSO_DATABASE_URL,
    tursoAuthToken: s(cfg.tursoAuthToken) ?? process.env.TURSO_AUTH_TOKEN,
    databaseUrl: s(cfg.databaseUrl) ?? process.env.DATABASE_URL ?? process.env.POSTGRES_URL,
    skillLimit: typeof cfg.skillLimit === "number" ? cfg.skillLimit : 60,
    namespace: s(cfg.namespace) ?? "learning",
  };
}


export function resolveBackend(): Backend {
  const cfg = settings();
  if (cfg.backend) return cfg.backend;
  if (cfg.tursoDatabaseUrl) return "turso";
  if (cfg.databaseUrl) return "postgres";
  throw new Error(
    "Learning store not configured. Pass config at the mount site or set env: " +
      "LEARNING_STORE=turso|postgres, TURSO_DATABASE_URL (Turso/libSQL), or DATABASE_URL / POSTGRES_URL (Postgres).",
  );
}

let storePromise: Promise<LearningStore> | undefined;

/** Lazily construct, init, and memoize the configured store for this process. */
export function getStore(): Promise<LearningStore> {
  return (storePromise ??= construct());
}

async function construct(): Promise<LearningStore> {
  const backend = resolveBackend();
  const store: LearningStore =
    backend === "turso"
      ? new (await import("./turso.js")).TursoStore()
      : new (await import("./postgres.js")).PostgresStore();
  await store.init();
  return store;
}

// ---------------------------------------------------------------------------
// Pure helpers shared by both adapters (keep IO in the adapters, logic here)
// ---------------------------------------------------------------------------

export function newId(): string {
  return globalThis.crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function computeUsage(entries: { content: string }[]): number {
  return entries.reduce((n, e) => n + e.content.length, 0);
}

export function usageInfo(entries: { content: string }[], scope: MemoryScope): UsageInfo {
  const used = computeUsage(entries);
  const limit = BUDGETS[scope];
  return { used, limit, pct: limit === 0 ? 0 : Math.round((used / limit) * 100) };
}

/** Resolve a unique entry by short substring (Hermes `old_text` semantics). */
export function pickUnique(
  entries: MemoryEntry[],
  substring: string,
): { entry?: MemoryEntry; error?: string } {
  const matches = entries.filter((e) => e.content.includes(substring));
  if (matches.length === 0) return { error: `No memory entry matches "${substring}".` };
  if (matches.length > 1)
    return { error: `"${substring}" matches ${matches.length} entries; use a more specific substring.` };
  return { entry: matches[0] };
}

const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/;
const THREAT_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /disregard\s+(the\s+)?system\s+prompt/i,
  /-----BEGIN[\w\s]+PRIVATE KEY-----/i,
  /\bapi[_-]?key\s*[:=]\s*\S/i,
  /\b(secret|access)[_-]?token\s*[:=]\s*\S/i,
  /ssh-(rsa|ed25519)\s+AAAA/i,
  /curl\s+[^|]+\|\s*(ba)?sh/i,
];

/**
 * Light guard: memory is injected into the system prompt, so it is a real
 * prompt-injection / exfiltration surface. Returns a reason to reject, or null.
 * Not exhaustive — pair with `memory.write_approval` style gating for hostile inputs.
 */
export function unsafeMemoryReason(text: string): string | null {
  if (INVISIBLE.test(text)) return "contains invisible/bidi control characters";
  for (const p of THREAT_PATTERNS) if (p.test(text)) return `matches a blocked pattern (${p.source})`;
  return null;
}

/** Owner key for multi-tenant scoping: the calling principal, or "local" when anonymous. */
export function ownerKey(
  auth: { current?: { principalId?: string | null } | null } | null | undefined,
): string {
  return auth?.current?.principalId ?? "local";
}
