/**
 * The table NAMES and the shipped DDL (Tenancy 2b-1, 4.1; D14). Pure: no
 * drizzle, no database. `./schema` builds the drizzle tables from the same
 * names, and a test builds the tables from `notificationsSql()` and runs the
 * package's whole service suite against them, so the SQL and the drizzle
 * definitions cannot drift without a test failing.
 *
 * WHY THE HOST CHOOSES THE NAMES (review G1). 0.1 owned a table literally
 * named `notifications`. A foreign host (Ridgeline) very often has its own
 * table of that name. With fixed names, `create table if not exists` would
 * quietly skip over the host's table and every statement the package sends
 * would land on it: a `cleanup()` deleting the host's rows. So:
 *   - a `prefix` (the analytics 0.2 pattern) and/or a Postgres `schema` of the
 *     host's give an independent set of names;
 *   - every script is ONE DO block that OPENS with its guards, which RAISE,
 *     in words, when a table of the target name exists and isn't the
 *     package's; the RAISE ends the one statement, so nothing is created
 *     (review FH-1);
 *   - `createNotifications` requires `tables` (no implicit default), and every
 *     statement that updates or deletes names a package-only column.
 */

export class InvalidTableNameError extends Error {
  readonly name = "InvalidTableNameError";
}

export interface DefineNotificationTablesOptions {
  /** "" (default: the 0.1 names) or /^[a-z][a-z0-9_]{0,30}_$/ (e.g. "aig_"). */
  readonly prefix?: string;
  /** A Postgres schema of the host's ("adminigloo"); default none (the connection's search path). /^[a-z_][a-z0-9_]{0,62}$/. */
  readonly schema?: string;
}

const PREFIX = /^[a-z][a-z0-9_]{0,30}_$/;
const SCHEMA = /^[a-z_][a-z0-9_]{0,62}$/;
/** Postgres truncates identifiers past 63 bytes, which makes drizzle-kit see a rename on every push. */
const PG_MAX_IDENTIFIER = 63;

/** Every name the package creates, resolved once from the options. */
export interface NotificationTableNames {
  readonly prefix: string;
  readonly schema: string | null;
  readonly alerts: string;
  readonly choices: string;
  readonly routing: string;
  readonly index: {
    readonly recipientCreated: string;
    readonly recipientRead: string;
    readonly dedupe: string;
    readonly inbox: string;
    readonly unread: string;
    readonly emailDue: string;
    readonly dedupeLookup: string;
    readonly created: string;
  };
  readonly choicesPk: string;
  readonly routingPk: string;
}

/**
 * The names under `options`. The default reproduces 0.1's EXACTLY (the table
 * `notifications`, its two index names), so a 0.1 install upgrades with ALTERs.
 * A name that would pass Postgres' 63-character limit under a long prefix
 * takes a shorter `{prefix}ntf_{what}` form (the analytics rule), never for
 * the default.
 */
export function notificationTableNames(options: DefineNotificationTablesOptions = {}): NotificationTableNames {
  const prefix = options.prefix ?? "";
  if (typeof prefix !== "string" || (prefix !== "" && !PREFIX.test(prefix))) {
    throw new InvalidTableNameError(
      `@adminigloo/notifications: a table prefix is lower-case letters, digits and underscores, starts with a letter, ends with "_" and is at most 32 characters (got ${JSON.stringify(prefix)}).`,
    );
  }
  const schema = options.schema ?? null;
  if (schema !== null && (typeof schema !== "string" || !SCHEMA.test(schema))) {
    throw new InvalidTableNameError(
      `@adminigloo/notifications: a schema name is lower-case letters, digits and underscores, at most 63 characters (got ${JSON.stringify(schema)}).`,
    );
  }
  const fitted = (derived: string, short: string) => (derived.length <= PG_MAX_IDENTIFIER ? derived : short);
  const alerts = `${prefix}notifications`;
  const choices = `${prefix}notification_choices`;
  const routing = `${prefix}notification_routing`;
  const idx = (what: string) => fitted(`${alerts}_${what}`, `${prefix}ntf_${what}`);
  return {
    prefix,
    schema,
    alerts,
    choices,
    routing,
    index: {
      recipientCreated: idx("recipient_created_idx"),
      recipientRead: idx("recipient_read_idx"),
      dedupe: idx("dedupe_uidx"),
      inbox: idx("inbox_idx"),
      unread: idx("unread_idx"),
      emailDue: idx("email_due_idx"),
      dedupeLookup: idx("dedupe_lookup_idx"),
      created: idx("created_idx"),
    },
    choicesPk: fitted(`${choices}_pk`, `${prefix}ntfc_pk`),
    routingPk: fitted(`${routing}_pk`, `${prefix}ntfr_pk`),
  };
}

/**
 * The alert table's columns, in order: name and DDL. The drizzle table in
 * `./schema` declares the same; the schema test compares the two against a
 * real database.
 */
export const ALERT_COLUMNS: ReadonlyArray<readonly [name: string, ddl: string]> = Object.freeze([
  ["id", "text primary key"],
  ["tenant_id", "text not null default '*'"],
  ["recipient_id", "text not null"],
  ["reached_via", "text not null default 'audience'"],
  ["kind", "text not null"],
  ["title", "text not null"],
  ["body", "text"],
  ["href", "text"],
  ["dedupe_key", "text"],
  ["subject_type", "text"],
  ["subject_id", "text"],
  ["actor_id", "text"],
  ["read_at", "timestamptz"],
  ["created_at", "timestamptz not null default now()"],
  ["email_status", "text not null default 'none'"],
  ["email_to", "text"],
  ["email_attempts", "integer not null default 0"],
  ["email_next_at", "timestamptz"],
  ["email_claimed_at", "timestamptz"],
  ["emailed_at", "timestamptz"],
  ["email_error", "text"],
] as const);

/** 0.1's columns: what the upgrade's guard requires, EXACTLY, and what it never adds. */
export const V01_ALERT_COLUMNS: readonly string[] = Object.freeze([
  "id",
  "recipient_id",
  "kind",
  "title",
  "body",
  "href",
  "read_at",
  "created_at",
]);

/** The choices table's columns, in order: name and DDL. */
export const CHOICE_COLUMNS: ReadonlyArray<readonly [name: string, ddl: string]> = Object.freeze([
  ["tenant_id", "text not null"],
  ["user_id", "text not null"],
  ["kind", "text not null"],
  ["channel", "text not null"],
  ["updated_at", "timestamptz not null default now()"],
] as const);

/** The routing table's columns, in order: name and DDL. */
export const ROUTING_COLUMNS: ReadonlyArray<readonly [name: string, ddl: string]> = Object.freeze([
  ["tenant_id", "text not null"],
  ["routing", "text not null"],
  ["mode", "text not null default 'owner'"],
  ["user_ids", "text[] not null default '{}'"],
  ["extra_emails", "text[] not null default '{}'"],
  ["updated_at", "timestamptz not null default now()"],
  ["updated_by", "text"],
] as const);

interface IndexDef {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique?: boolean;
  readonly where?: string;
}

function alertIndexes(n: NotificationTableNames): IndexDef[] {
  return [
    // 0.1's two, names kept exactly (the inbox and badge queries of 0.1).
    { name: n.index.recipientCreated, columns: ["recipient_id", "created_at"] },
    { name: n.index.recipientRead, columns: ["recipient_id", "read_at"] },
    // D7. NULLs are distinct in Postgres, so 0.1's rows (no key) never
    // collide, and `on conflict` needs no predicate.
    { name: n.index.dedupe, columns: ["tenant_id", "recipient_id", "dedupe_key"], unique: true },
    { name: n.index.inbox, columns: ["tenant_id", "recipient_id", "created_at", "id"] },
    { name: n.index.unread, columns: ["tenant_id", "recipient_id"], where: `"read_at" is null` },
    { name: n.index.emailDue, columns: ["email_next_at"], where: `"email_status" in ('pending', 'sending')` },
    { name: n.index.dedupeLookup, columns: ["tenant_id", "dedupe_key"] },
    { name: n.index.created, columns: ["created_at"] },
  ];
}

const quote = (name: string) => `"${name}"`;
const literal = (text: string) => `'${text.replace(/'/g, "''")}'`;
const names = (columns: ReadonlyArray<readonly [string, string]>) => columns.map(([name]) => name);
/** Every line of `text` indented by two spaces: a statement inside the script's one DO block. */
const inBlock = (text: string) =>
  text
    .split("\n")
    .map((line) => (line === "" ? line : `  ${line}`))
    .join("\n");

function qualified(n: NotificationTableNames, table: string): string {
  return n.schema ? `${quote(n.schema)}.${quote(table)}` : quote(table);
}
/** How a table is named in a sentence: `adminigloo.aig_notifications`, or `notifications`. */
function shown(n: NotificationTableNames, table: string): string {
  return n.schema ? `${n.schema}.${table}` : table;
}

/**
 * The live column names of the relation `regclass` names, read from
 * pg_attribute of the VERY relation to_regclass found (review FH-3, storage's
 * rule): information_schema needs the schema spelled out, and
 * `current_schema()` isn't always where the search path found the table.
 */
function columnsOf(regclass: string): string {
  return `array(select attname::text from pg_attribute where attrelid = to_regclass(${literal(regclass)}) and attnum > 0 and not attisdropped)`;
}

function textArray(items: readonly string[]): string {
  return `array[${items.map(literal).join(", ")}]::text[]`;
}

/**
 * One guard (review G1, FH-3), as lines of the script's DO block: the target
 * table exists but lacks ANY of the package's columns → raise, in words.
 * Every column, not one: a host's own `notifications` that tracks email very
 * plausibly has `email_status`, but never `reached_via`, `dedupe_key`,
 * `email_claimed_at` and the rest together. A table that already is the
 * package's (this version's, or a later one, which only adds columns) passes,
 * so running the script twice is safe.
 */
function guard(n: NotificationTableNames, table: string, columns: readonly string[], message: string): string {
  const regclass = qualified(n, table);
  return [
    `if to_regclass(${literal(regclass)}) is not null and not (`,
    `  ${columnsOf(regclass)}`,
    `    @> ${textArray(columns)}`,
    ") then",
    `  raise exception ${literal(message)};`,
    "end if;",
  ].join("\n");
}

function choicesAndRoutingGuards(n: NotificationTableNames): string[] {
  return [
    guard(n, n.choices, names(CHOICE_COLUMNS), `A table named ${shown(n, n.choices)} already exists and isn't AdminIgloo's. Pass a prefix or a schema.`),
    guard(n, n.routing, names(ROUTING_COLUMNS), `A table named ${shown(n, n.routing)} already exists and isn't AdminIgloo's. Pass a prefix or a schema.`),
  ];
}

function createTable(n: NotificationTableNames, table: string, columns: ReadonlyArray<readonly [string, string]>, constraint?: string): string {
  const lines = columns.map(([name, ddl]) => `  ${quote(name)} ${ddl}`);
  if (constraint) lines.push(`  ${constraint}`);
  return [`create table if not exists ${qualified(n, table)} (`, lines.join(",\n"), ");"].join("\n");
}

function createIndex(n: NotificationTableNames, table: string, index: IndexDef): string {
  const columns = index.columns.map(quote).join(", ");
  const where = index.where ? ` where ${index.where}` : "";
  return `create ${index.unique ? "unique " : ""}index if not exists ${quote(index.name)} on ${qualified(n, table)} (${columns})${where};`;
}

function createChoicesAndRouting(n: NotificationTableNames): string[] {
  return [
    createTable(n, n.choices, CHOICE_COLUMNS, `constraint ${quote(n.choicesPk)} primary key ("tenant_id", "user_id", "kind")`),
    createTable(n, n.routing, ROUTING_COLUMNS, `constraint ${quote(n.routingPk)} primary key ("tenant_id", "routing")`),
  ];
}

/**
 * The script's one statement: `do $$ begin`, the parts, `end $$;`.
 *
 * WHY ONE STATEMENT (review FH-1). psql's defaults are autocommit on and
 * ON_ERROR_STOP off. With the guard as a statement of its own, `psql -f`
 * printed the guard's error and then ran every later statement: `create table
 * if not exists` skipped the host's table, and each `create index if not
 * exists` whose columns happened to exist landed ON the host's table. Inside
 * one DO block the RAISE ends the whole statement, so a failed guard creates
 * nothing, whatever runs the file and however it splits statements.
 */
function oneBlock(parts: readonly string[]): string {
  return ["do $$ begin", parts.map(inBlock).join("\n\n"), "end $$;"].join("\n");
}

const ONE_STATEMENT_NOTE = [
  "-- One statement: the guards first, then every table and index. If a guard finds a table of the",
  "-- same name that isn't AdminIgloo's, it stops with a sentence saying so, and nothing is created.",
];

/**
 * Review FH-2: a Prisma host diffs `public` against schema.prisma, which has
 * no model for these tables, so its next migration after the one that made
 * them drops them. A schema of their own is invisible to Prisma.
 */
export const PRISMA_NOTE =
  '-- With Prisma, use notificationsSql({ schema: "adminigloo" }) instead: Prisma drops tables in public that schema.prisma has no model for.';

/**
 * The DDL for these tables under `options` (create schema / table / index IF
 * NOT EXISTS), for a host without drizzle-kit. `sql/notifications-0.2.0.sql`
 * is exactly `notificationsSql()` (a test asserts it). Paste it into a Prisma
 * migration (`prisma migrate dev --create-only`, with a `schema`) and every
 * environment gets it through the host's own migration history.
 */
export function notificationsSql(options: DefineNotificationTablesOptions = {}): string {
  const n = notificationTableNames(options);
  const header = [
    "-- @adminigloo/notifications 0.2.0: the alert tables.",
    `-- Tables: ${shown(n, n.alerts)}, ${shown(n, n.choices)}, ${shown(n, n.routing)}.`,
    ...ONE_STATEMENT_NOTE,
    ...(n.schema ? [] : [PRISMA_NOTE]),
  ].join("\n");
  const parts: string[] = [
    guard(
      n,
      n.alerts,
      names(ALERT_COLUMNS),
      `A table named ${shown(n, n.alerts)} already exists and isn't AdminIgloo's 0.2 table. If it is AdminIgloo's 0.1 table, run sql/upgrade-0.1-to-0.2.sql; otherwise pass a prefix or a schema.`,
    ),
    ...choicesAndRoutingGuards(n),
  ];
  if (n.schema) parts.push(`create schema if not exists ${quote(n.schema)};`);
  parts.push(
    createTable(n, n.alerts, ALERT_COLUMNS),
    alertIndexes(n)
      .map((index) => createIndex(n, n.alerts, index))
      .join("\n"),
    ...createChoicesAndRouting(n),
  );
  return `${header}\n\n${oneBlock(parts)}\n`;
}

/**
 * `sql/upgrade-0.1-to-0.2.sql`: 0.1's table (the default names only: 0.1
 * had no prefix) gains 0.2's columns, indexes and the two new tables. ONE
 * statement, like `notificationsSql` (review FH-1).
 *
 * ITS GUARD (review FH-3, storage's rule): the table has EXACTLY 0.1's eight
 * columns and 0.1's index `notifications_recipient_created_idx` on it, or it
 * already has every column of 0.2 (running it twice is a no-op). Anything
 * else raises and nothing is altered, so it never ALTERs a host's own
 * `notifications`, however many of 0.1's generic column names (id, kind,
 * title, …) that table shares.
 */
export function notificationsUpgradeSql(): string {
  const n = notificationTableNames();
  const added = ALERT_COLUMNS.filter(([name]) => !V01_ALERT_COLUMNS.includes(name));
  const regclass = qualified(n, n.alerts);
  const cols = columnsOf(regclass);
  const header = [
    "-- @adminigloo/notifications: upgrade 0.1 -> 0.2 (the default table names).",
    "-- 0.1's rows become the firm-wide staff inbox (tenant_id '*'); no company's bell shows them.",
    "-- One statement: the guards first. If the table named notifications isn't AdminIgloo's 0.1 table,",
    "-- it stops with a sentence saying so, and nothing is altered or created.",
  ].join("\n");
  const parts: string[] = [
    [
      `if to_regclass(${literal(regclass)}) is null then`,
      `  raise exception ${literal("There's no table named notifications to upgrade. Run sql/notifications-0.2.0.sql to create it.")};`,
      "end if;",
      "if not (",
      `  (${cols} @> ${textArray(V01_ALERT_COLUMNS)}`,
      `    and ${cols} <@ ${textArray(V01_ALERT_COLUMNS)}`,
      "    and exists (",
      "      select 1 from pg_index i join pg_class c on c.oid = i.indexrelid",
      `       where i.indrelid = to_regclass(${literal(regclass)}) and c.relname = ${literal(n.index.recipientCreated)}`,
      "    ))",
      `  or ${cols} @> ${textArray(names(ALERT_COLUMNS))}`,
      ") then",
      `  raise exception ${literal(
        "The table named notifications isn't AdminIgloo's 0.1 table. Pass a prefix or a schema and run notificationsSql() instead.",
      )};`,
      "end if;",
    ].join("\n"),
    ...choicesAndRoutingGuards(n),
    [
      `alter table ${qualified(n, n.alerts)}`,
      added.map(([name, ddl]) => `  add column if not exists ${quote(name)} ${ddl}`).join(",\n") + ";",
    ].join("\n"),
    alertIndexes(n)
      .map((index) => createIndex(n, n.alerts, index))
      .join("\n"),
    ...createChoicesAndRouting(n),
  ];
  return `${header}\n\n${oneBlock(parts)}\n`;
}
