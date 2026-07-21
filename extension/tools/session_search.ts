/**
 * `session_search` tool — full-text recall over past conversations.
 *
 * Backed by SQLite FTS5 (Turso) or Postgres tsvector/GIN, whichever the store is
 * configured for. Returns ranked snippets so the agent can ground itself in what
 * was actually said before instead of guessing.
 */

import { defineTool } from "eve/tools";
import { z } from "zod";

import { getStore, ownerKey } from "../lib/learning/store";

const MAX_CONTENT = 500;

export default defineTool({
  description:
    "Search the full text of your past sessions and return the most relevant message snippets. Use this to recall " +
    "specific details, decisions, or facts from earlier conversations rather than relying on memory. Supports plain " +
    "keywords and quoted phrases.",
  inputSchema: z.object({
    query: z.string().describe("Keywords or a quoted phrase to search for."),
    limit: z.number().int().min(1).max(20).default(8),
  }),
  async execute(input, ctx) {
    const store = await getStore();
    const hits = await store.search(ownerKey(ctx.session.auth), input.query, input.limit);
    return {
      count: hits.length,
      hits: hits.map((h) => ({
        sessionId: h.sessionId,
        role: h.role,
        when: h.createdAt,
        snippet: h.snippet,
        content: h.content.length > MAX_CONTENT ? `${h.content.slice(0, MAX_CONTENT)}…` : h.content,
        score: Number(h.score.toFixed(4)),
      })),
    };
  },
});
