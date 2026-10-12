import { and, desc, eq, isNull, lt, or } from "drizzle-orm";
import { z } from "zod";
import { sha256Hex } from "./image.js";
import { estimatorClientKeys } from "./schema.js";
import type { ClientKeyDbRow, EstimatorDb } from "./types.js";
import type { KeyWire } from "./wire.js";

/**
 * Embed keys: the licence for the estimator widget on a business's OWN
 * website (section 6.10 of the 0.3 contract). The key in `x-adminigloo-key`
 * resolves the tenant; only its SHA-256 is stored.
 *
 * ALLOWED ORIGINS (0.3, ES-05). A key used to work from any website: anyone
 * who copied it from the page source could run the business's estimator — and
 * its photo reading — from their own. Each key now carries the websites it
 * works on. An EMPTY list still means any website, so 0.2 keys keep working;
 * the admin flags them until an owner adds theirs.
 */

/** `esk_…` — an estimator embed key. The prefix triages a leaked string at a glance. */
export const ESTIMATOR_KEY_PREFIX = "esk_";
/** The header the widget sends its key in — shared with the other adminigloo widgets. */
export const ESTIMATOR_KEY_HEADER = "x-adminigloo-key";

const ORIGIN_MESSAGE = "Use the site's address, like https://summitramps.com";

/**
 * A website as the browser names it in `Origin`: lowercased
 * `scheme://host[:port]`, https (or http for localhost / 127.0.0.1), with no
 * path, query or credentials. Null when it isn't one.
 */
export function normalizeOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 300) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const local = host === "localhost" || host === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  if (/[?#]/.test(trimmed)) return null;
  return `${url.protocol}//${host}${url.port ? `:${url.port}` : ""}`;
}

/** ≤ 20 websites, each normalized; a bad one is an issue on its index. */
export const allowedOriginsSchema = z
  .array(z.string().transform((value, ctx) => {
    const origin = normalizeOrigin(value);
    if (!origin) {
      ctx.addIssue({ code: "custom", message: ORIGIN_MESSAGE });
      return z.NEVER;
    }
    return origin;
  }))
  .max(20, "Up to 20 websites per key.")
  .transform((origins) => [...new Set(origins)]);

/**
 * Does this key work from this page? An empty list allows any origin (0.2
 * keys). A keyed request with no `Origin` (a server, curl) is allowed: the
 * list is a guard on BROWSERS, which always send it cross-site.
 */
export function originAllowed(allowedOrigins: readonly string[], origin: string | null): boolean {
  if (allowedOrigins.length === 0 || origin === null) return true;
  const normalized = normalizeOrigin(origin);
  return normalized !== null && allowedOrigins.includes(normalized);
}

function randomHexToken(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return prefix + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 20 random bytes as hex behind the prefix; the plaintext exists only in the issuance response. */
export function generateClientKey(): string {
  return randomHexToken(ESTIMATOR_KEY_PREFIX);
}

export async function hashClientKey(key: string): Promise<string> {
  return sha256Hex(key);
}

export interface IssuedClientKey {
  id: string;
  tenantId: string;
  label: string;
  /** The one and only time the plaintext is available. */
  key: string;
  allowedOrigins: string[];
}

const labelSchema = z.string().trim().min(1, "Give the key a name, like the website it's for.").max(120);

const issueClientKeySchema = z.object({ label: labelSchema, allowedOrigins: allowedOriginsSchema.default([]) });

export async function issueClientKey(
  db: EstimatorDb,
  input: { tenantId: string; label: string; allowedOrigins?: readonly string[] },
): Promise<IssuedClientKey> {
  // Parsed together, so an issue names its field (`["allowedOrigins", 0]`).
  const { label, allowedOrigins } = issueClientKeySchema.parse({ label: input.label, allowedOrigins: input.allowedOrigins ?? [] });
  const key = generateClientKey();
  const keyHash = await hashClientKey(key);
  const [row] = await db
    .insert(estimatorClientKeys)
    .values({ tenantId: input.tenantId, label, keyPrefix: key.slice(0, 12), keyHash, allowedOrigins })
    .returning({ id: estimatorClientKeys.id });
  if (!row) throw new Error("key insert returned no row");
  return { id: (row as { id: string }).id, tenantId: input.tenantId, label, key, allowedOrigins };
}

export const updateClientKeySchema = z
  .object({ label: labelSchema, allowedOrigins: allowedOriginsSchema })
  .partial();

/** Rename a key or change its websites; null when it isn't this tenant's. */
export async function updateClientKey(
  db: EstimatorDb,
  tenantId: string,
  keyId: string,
  patch: z.input<typeof updateClientKeySchema>,
): Promise<ClientKeyRow | null> {
  const parsed = updateClientKeySchema.parse(patch);
  const [row] = (await db
    .update(estimatorClientKeys)
    .set(parsed)
    .where(and(eq(estimatorClientKeys.id, keyId), eq(estimatorClientKeys.tenantId, tenantId)))
    .returning()) as ClientKeyDbRow[];
  return row ? toKeyRow(row) : null;
}

/**
 * Revoke one of this tenant's embed keys; false when it is not theirs. It used
 * to take any key id, so one workspace could switch off another's widget.
 */
export async function revokeClientKey(db: EstimatorDb, tenantId: string, keyId: string): Promise<boolean> {
  const [row] = await db
    .update(estimatorClientKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(estimatorClientKeys.id, keyId), eq(estimatorClientKeys.tenantId, tenantId), isNull(estimatorClientKeys.revokedAt)))
    .returning({ id: estimatorClientKeys.id });
  if (row) return true;
  // Already revoked is still "yes, it's revoked".
  const [existing] = await db
    .select({ id: estimatorClientKeys.id })
    .from(estimatorClientKeys)
    .where(and(eq(estimatorClientKeys.id, keyId), eq(estimatorClientKeys.tenantId, tenantId)))
    .limit(1);
  return existing !== undefined;
}

export interface ClientKeyRow {
  id: string;
  label: string;
  keyPrefix: string;
  /** 0.3: the websites it works on ([] = any). */
  allowedOrigins: string[];
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

function toKeyRow(row: ClientKeyDbRow): ClientKeyRow {
  return {
    id: row.id,
    label: row.label,
    keyPrefix: row.keyPrefix,
    allowedOrigins: Array.isArray(row.allowedOrigins) ? row.allowedOrigins.filter((o): o is string => typeof o === "string") : [],
    revokedAt: row.revokedAt,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
  };
}

/** The keys for a tenant — never the hash, never the plaintext. */
export async function listClientKeys(db: EstimatorDb, tenantId: string): Promise<ClientKeyRow[]> {
  const rows = (await db
    .select()
    .from(estimatorClientKeys)
    .where(eq(estimatorClientKeys.tenantId, tenantId))
    .orderBy(desc(estimatorClientKeys.createdAt))) as ClientKeyDbRow[];
  return rows.map(toKeyRow);
}

/** A key as the admin shows it. */
export function toKeyWire(row: ClientKeyRow): KeyWire {
  return {
    id: row.id,
    label: row.label,
    keyPrefix: row.keyPrefix,
    allowedOrigins: [...row.allowedOrigins],
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface VerifiedClientKey {
  keyId: string;
  tenantId: string;
  /** 0.3: the websites the key works on ([] = any). */
  allowedOrigins: string[];
}

/** `last_used_at` is touched at most this often (ES-08: no write per keystroke). */
const LAST_USED_EVERY_MS = 10 * 60 * 1000;

/**
 * Resolve a key to its tenant, or null — which the caller turns into a 401,
 * never a guessed tenant. Touches `last_used_at` so a dead key is visible in
 * the admin, but only when it is unset or older than 10 minutes: the widget
 * prices on every keystroke, and 0.2 wrote the row each time. The prefix check
 * short-circuits a token meant for another widget.
 */
export async function verifyClientKey(db: EstimatorDb, key: string, options: { now?: Date } = {}): Promise<VerifiedClientKey | null> {
  if (typeof key !== "string" || !key.startsWith(ESTIMATOR_KEY_PREFIX) || key.length > 200) return null;
  const keyHash = await hashClientKey(key);
  const [row] = (await db
    .select({
      id: estimatorClientKeys.id,
      tenantId: estimatorClientKeys.tenantId,
      allowedOrigins: estimatorClientKeys.allowedOrigins,
      lastUsedAt: estimatorClientKeys.lastUsedAt,
    })
    .from(estimatorClientKeys)
    .where(and(eq(estimatorClientKeys.keyHash, keyHash), isNull(estimatorClientKeys.revokedAt)))
    .limit(1)) as Array<{ id: string; tenantId: string; allowedOrigins: unknown; lastUsedAt: Date | null }>;
  if (!row) return null;
  const now = options.now ?? new Date();
  if (row.lastUsedAt === null || now.getTime() - row.lastUsedAt.getTime() > LAST_USED_EVERY_MS) {
    await db
      .update(estimatorClientKeys)
      .set({ lastUsedAt: now })
      .where(
        and(
          eq(estimatorClientKeys.id, row.id),
          or(isNull(estimatorClientKeys.lastUsedAt), lt(estimatorClientKeys.lastUsedAt, new Date(now.getTime() - LAST_USED_EVERY_MS))),
        ),
      );
  }
  const origins = Array.isArray(row.allowedOrigins) ? row.allowedOrigins.filter((o): o is string => typeof o === "string") : [];
  return { keyId: row.id, tenantId: row.tenantId, allowedOrigins: origins };
}
