/**
 * `skill_manage` tool — lets the agent author and refine its own skills.
 *
 * Skills written here are stored externally and surfaced next session as native
 * skills under this extension's mount namespace (see ../skills/learned.ts), so the loop is closed:
 * the agent notices a reusable procedure, writes it down, and the framework
 * advertises it back as a first-class skill on the next run.
 */

import { defineTool } from "eve/tools";
import { z } from "zod";

import { getStore, ownerKey } from "../lib/learning/store";

const NAME = /^[a-z0-9][a-z0-9_-]*$/;

export default defineTool({
  description:
    "Author and maintain your own reusable skills (procedural memory). action=create saves a new skill from a full " +
    "Markdown body; action=patch replaces a unique `old_string` with `new_string` in an existing skill; action=edit " +
    "rewrites the whole body and/or description; action=delete removes one (refused if pinned); action=pin/unpin " +
    "protects a skill from the curator. Write a skill when you work out a non-trivial, reusable workflow or recover " +
    "from a dead-end worth remembering. Saved skills become loadable from your next session.",
  inputSchema: z.object({
    action: z.enum(["create", "patch", "edit", "delete", "pin", "unpin"]),
    name: z.string().describe("Skill slug: lowercase letters, digits, '-' or '_'."),
    description: z.string().optional().describe("One line shown to you when deciding whether to load it (create/edit)."),
    content: z.string().optional().describe("Full Markdown skill body (create/edit)."),
    category: z.string().optional(),
    old_string: z.string().optional().describe("Unique text to replace (patch)."),
    new_string: z.string().optional().describe("Replacement text (patch)."),
  }),
  async execute(input, ctx) {
    const store = await getStore();
    const owner = ownerKey(ctx.session.auth);

    if (!NAME.test(input.name))
      return { ok: false, name: input.name, error: "Invalid name. Use lowercase letters, digits, '-' or '_'." };

    switch (input.action) {
      case "create": {
        if (!input.description || !input.content)
          return { ok: false, name: input.name, error: "`description` and `content` are required for create." };
        return store.createSkill(owner, {
          name: input.name,
          description: input.description,
          markdown: input.content,
          category: input.category,
        });
      }
      case "edit": {
        if (!input.content && !input.description && !input.category)
          return { ok: false, name: input.name, error: "Provide at least one of `content`, `description`, `category`." };
        return store.editSkill(owner, input.name, {
          markdown: input.content,
          description: input.description,
          category: input.category,
        });
      }
      case "patch": {
        if (input.old_string == null || input.new_string == null)
          return { ok: false, name: input.name, error: "`old_string` and `new_string` are required for patch." };
        return store.patchSkill(owner, input.name, input.old_string, input.new_string);
      }
      case "delete":
        return store.deleteSkill(owner, input.name);
      case "pin":
        return store.setPinned(owner, input.name, true);
      case "unpin":
        return store.setPinned(owner, input.name, false);
    }
  },
});
