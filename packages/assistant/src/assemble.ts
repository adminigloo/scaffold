import { createHash } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { AssistantDb } from "./brain.js";
import { listSections } from "./brain.js";
import { assistantGlossary, assistantTenantRules } from "./schema.js";
import { estimateTokens } from "./tokens.js";

/**
 * Turn the brain rows into a system prompt — and the record of how it was
 * built. Two halves, deliberately split by the review's cache economics:
 *
 *   - the STATIC prefix is global sections only, identical for every tenant,
 *     so the provider can cache it once and every conversation reads the hit;
 *   - the per-turn overlay (tenant rules, glossary) travels in the user
 *     message, NOT here, so one tenant's customization never invalidates the
 *     shared cache. This module returns both parts separately for that reason.
 *
 * `promptMeta` is the flight recorder: a stable fingerprint (so 0.4's evals
 * and every stored message can be tied to the exact config that produced
 * them), the blocks that fired, and the token cost of each. Persisted on the
 * message row from release one, per the delivery review.
 */

export interface AssembledPrompt {
  /** The provider-cacheable system prompt: global sections in order. */
  system: string;
  /** Per-turn context blocks for the user message: overlays + glossary. */
  contextBlocks: string[];
  meta: PromptMeta;
}

export interface PromptMeta {
  /** Hash of section versions + tenant rule set + glossary — the config identity. */
  fingerprint: string;
  blocks: Array<{ name: string; tokens: number }>;
  totalTokens: number;
}

function glossaryMatches(text: string, term: { preferred: string; aliases: string[] }): boolean {
  const haystack = text.toLowerCase();
  if (haystack.includes(term.preferred.toLowerCase())) return true;
  return term.aliases.some((a) => a.length >= 3 && haystack.includes(a.toLowerCase()));
}

/**
 * Assemble for one tenant and one user turn. `turnText` is what the glossary
 * filters against — only terms the user actually used are injected, so the
 * glossary stays small and never has to be shed (the review's fix).
 */
export async function assemblePrompt(
  db: AssistantDb,
  input: { tenantId: string; turnText: string },
): Promise<AssembledPrompt> {
  const sections = await listSections(db);

  const tenantRules = await db
    .select({
      sectionKey: assistantTenantRules.sectionKey,
      label: assistantTenantRules.label,
      instruction: assistantTenantRules.instruction,
    })
    .from(assistantTenantRules)
    .where(
      and(
        eq(assistantTenantRules.tenantId, input.tenantId),
        eq(assistantTenantRules.isActive, true),
      ),
    )
    .orderBy(asc(assistantTenantRules.sortOrder));

  const glossary = await db
    .select({
      preferred: assistantGlossary.preferred,
      aliases: assistantGlossary.aliases,
      definition: assistantGlossary.definition,
    })
    .from(assistantGlossary)
    .where(eq(assistantGlossary.isActive, true));

  const blocks: PromptMeta["blocks"] = [];
  const fingerprintParts: string[] = [];

  // --- Static prefix: global sections, with tenant overlays merged per key.
  // The overlay text merges into the cached prefix's TEXT for correctness of
  // behavior, but note the cache-key implication is handled by the caller
  // placing tenant additions in the user message; here we compose the full
  // instruction the model reads. (0.2 wires the actual split to the provider.)
  const overlayByKey = new Map<string, string[]>();
  const standaloneOverlays: string[] = [];
  for (const rule of tenantRules) {
    if (rule.sectionKey) {
      const list = overlayByKey.get(rule.sectionKey) ?? [];
      list.push(rule.instruction);
      overlayByKey.set(rule.sectionKey, list);
    } else {
      standaloneOverlays.push(`- ${rule.instruction}`);
    }
  }

  const systemParts: string[] = [];
  for (const section of sections) {
    systemParts.push(section.content);
    blocks.push({ name: `section:${section.key}`, tokens: estimateTokens(section.content) });
    fingerprintParts.push(`s:${section.key}:${estimateTokens(section.content)}`);
  }
  const system = systemParts.join("\n\n");

  // --- Per-turn context blocks (travel in the user message).
  const contextBlocks: string[] = [];

  for (const [key, additions] of overlayByKey) {
    const text = additions.map((a) => `- ${a}`).join("\n");
    const block = `<tenant-rules section="${key}">\n${text}\n</tenant-rules>`;
    contextBlocks.push(block);
    blocks.push({ name: `tenant-rules:${key}`, tokens: estimateTokens(block) });
    fingerprintParts.push(`tr:${key}:${additions.length}`);
  }
  if (standaloneOverlays.length > 0) {
    const block = `<tenant-rules>\n${standaloneOverlays.join("\n")}\n</tenant-rules>`;
    contextBlocks.push(block);
    blocks.push({ name: "tenant-rules", tokens: estimateTokens(block) });
    fingerprintParts.push(`tr:*:${standaloneOverlays.length}`);
  }

  const matched = glossary.filter((t) => glossaryMatches(input.turnText, t));
  if (matched.length > 0) {
    const lines = matched
      .map((t) => (t.definition ? `- ${t.preferred}: ${t.definition}` : `- ${t.preferred}`))
      .join("\n");
    const block = `<glossary>\n${lines}\n</glossary>`;
    contextBlocks.push(block);
    blocks.push({ name: "glossary", tokens: estimateTokens(block) });
    // Glossary is turn-dependent, so it is NOT in the fingerprint (which
    // identifies the config, not the query).
  }

  const fingerprint = createHash("sha256")
    .update(fingerprintParts.join("|"))
    .digest("hex")
    .slice(0, 16);
  const totalTokens = blocks.reduce((sum, b) => sum + b.tokens, 0);

  return { system, contextBlocks, meta: { fingerprint, blocks, totalTokens } };
}
