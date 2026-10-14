# @adminigloo/estimator

Instant estimates for a business that prices jobs from measurements: ramps,
concrete pads, handrail, fencing, glass. A customer answers questions they can
actually answer ("How many steps go up to the door?"), and sees a real price
range in a second, worked out from the business's own supply costs, labor and
markup. They can add a photo; it is kept for the business, and an AI reads it
for **counts only** ("We counted 3 steps up, including the last one onto the
porch or landing"). The code does every calculation and explains it in plain
words. The business gets the lead by email, edits it, sends a formal quote by
link, and the customer accepts or declines online. A follow-up goes if nobody
answers, and the quote expires when it should.

Every function is scoped to a tenant (one business). This package is the
server: the functions, two HTTP handlers, and the emails (`./comms`). The
screens are `@adminigloo/estimator-widget`.

```
@adminigloo/estimator            functions, types, permission keys, the two HTTP handlers (and the tables, re-exported)
@adminigloo/estimator/schema     the drizzle pgTables
@adminigloo/estimator/comms      the emails: lead, copy, quote, follow-up, accepted, expired, office notices (needs @adminigloo/comms)
@adminigloo/estimator/anthropic  the photo reading on Claude Haiku 4.5 (needs @anthropic-ai/sdk)
```

Peers: `drizzle-orm` (^0.45) and `zod` (**^4**: the package's type
declarations are built against zod 4; see [Install](#install) if your app is
on zod 3). `@adminigloo/comms` (for `./comms`) and `@anthropic-ai/sdk` (for
`./anthropic`) are optional peers: an app that sends its own mail, or reads no
photos, never installs them. No database driver is a dependency: bring your
own drizzle instance (node-postgres, postgres.js, Neon, PGlite).

## What you get

The scenario this release is tested against, end to end
(`src/__tests__/business-scenario.test.ts`), for a wheelchair-ramp company:

1. **The owner sets up the price book** in the admin: products built from
   their supplies (cost × how much per foot of ramp, per item or per job;
   posts and platforms bought whole), labor hours × a rate plus setup, waste,
   markup or a target margin, a minimum, the range rule, options. Or they
   click **Load a sample catalog**: it arrives **off the website**, so made-up
   prices reach no customer until the owner turns each product on. Nothing
   seeds itself from a public page.
2. **A customer gets an instant estimate** by answering what they know. The
   code shows its working: "3 steps × 7–8 in each (estimated) = 21–24 in rise →
   ADA 1:12 slope (1 ft of ramp per inch of rise) → 21–24 ft of ramp". A photo
   pre-fills the step count, which the customer can change.
3. **The lead is saved** with the photo, the reading and the customer's
   corrections. The office gets a new-lead email; the customer gets a copy.
4. **Staff open it** in a queue, edit the lines (re-priced from the price book,
   totals recomputed in one transaction) and **send a quote** by link, told
   first which lines rest on an assumption.
5. **The customer accepts or declines** online — the version they were shown,
   nothing else; staff are told. No answer → a follow-up after N days,
   withdrawn the moment they answer. Quotes expire, and every expiry is
   announced.
6. **An accepted quote is one click** from booking the visit (scheduling) and
   from an invoice (invoicing). The package exposes the seams.
7. **Public writes are protected**: a honeypot, a minimum fill time, website
   keys that work only on the business's own site, a rate-limit seam, a daily
   photo cap per visitor, and an AI budget that fails closed.

**Nothing reaches a customer until the business is set up.** Until the owner
saves the business's name in Settings (whose first-run form asks for the tax
rate and the default labor rate in the same save), the estimate page and the
embed say "Instant estimates aren't available right now", and a quote can't be
sent (`settings_incomplete`). A product that would price at $0 is answered as
"priced by a person" on the public side, never as $0.

| You install / import | You get | You wire yourself |
| --- | --- | --- |
| `@adminigloo/estimator` + `./schema` | The price book (products, the supplies library, options), measurement recipes, the price build, settings, leads, staff estimates, quotes with hashed, versioned links, photos (through your file store), the reading pipeline with its cache, budget and limits, events, two HTTP handlers, permission keys. | The twelve tables in your migration. A photo store adapter (a few lines over your file storage). |
| `+ ./comms` (with `@adminigloo/comms`) | Seven plain-text emails, a follow-up queued for the cron and withdrawn on any answer, and no quote link ever left in the delivery log. | Comms' three tables, your mail sender, and the cron route (see [Emails](#emails-comms)). |
| `+ ./anthropic` (with `@anthropic-ai/sdk`) | The photo reading: one small call per photo on Claude Haiku 4.5. | Your `new Anthropic()` client (the package never reads a key). |
| `+ @adminigloo/estimator-widget` | `<EstimateTool>`, `<QuoteView>`, and the admin: price book, queue, editor, settings, embed keys. | The two routes below. |
| `create-adminigloo-app --estimator` | All of the above, wired, for one business. | — |

## Not included

- Payments or deposits when a quote is accepted (that's the invoicing chunk).
- E-signature. Accepting records the name the customer typed and when.
- SMS. Every message is email; staff can copy the quote link and text it.
- Currency conversion. One currency per business, shown as set.
- A script tag or iframe widget for non-React sites (WordPress, Wix,
  Squarespace), and installing from the public npm registry.
- PDF files. The quote page prints cleanly ("Print or save as PDF").
- More than one item per estimate from the website widget (staff add lines in
  the editor).
- Photo readings for areas and lengths: a size guessed from a photo without a
  scale isn't a number to price from. Those photos are still kept.
- Per-line tax rules (taxable materials, untaxed labor). One rate per estimate.
- Product images, a category table, required options, and percentage or
  per-unit option prices.
- A customer record (CRM). An estimate stores the name, email, phone and
  address as typed.
- Turning an estimate into a job or project, beyond booking the visit and
  invoicing it.
- Per-company boards and widgets for feedback, notifications, files, the
  assistant, analytics, SEO/AEO and book-a-call: Tenancy 2b. (The estimator
  itself is per company since 0.4: see [Companies](#companies-tenancy-2a).)
- Payments to companies, plans and billing per company, custom domains,
  impersonation, per-company SEO and search indexing of company pages.
- Logo and colour inside emails. Emails carry the company's name and reply-to;
  their bodies are plain text.
- Win-rate or pipeline reports.
- A two-way price-list sync. Supplies can be fed FROM your own price list
  (below); changes made in the price book are announced (`onPriceBookChange`)
  for you to write back yourself.
- Supplies sold in fixed lengths ("comes in 8-ft pieces"). "Round up to whole
  units" covers what is bought each; a length is priced by the foot.

## Install

The packages are published to GitHub Packages. The same block works for npm
and pnpm. In your app's **repo** `.npmrc` (commit it: it holds no secret, the
token is read from the environment):

```
@adminigloo:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

`GITHUB_TOKEN` is a GitHub token with `read:packages`, set in your shell and in
CI. Then:

```bash
npm install @adminigloo/estimator drizzle-orm zod      # or: pnpm add …
npm install @adminigloo/comms                          # for the emails
npm install @anthropic-ai/sdk                          # for photo reading
npm install @adminigloo/estimator-widget react react-dom
npm install -D drizzle-kit                             # if drizzle owns your migrations
```

**Docker.** A clean image has no token: pass it as a BuildKit secret, never a
build argument (an argument stays in the image's history):

```dockerfile
# syntax=docker/dockerfile:1
COPY package.json package-lock.json .npmrc ./
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc npm ci
```

```bash
docker build --secret id=npmrc,src=$HOME/.npmrc .
```

**zod.** The package needs zod 4 (`^4.0.0`). On zod 3.24 or older, npm stops
with `ERESOLVE`; don't answer it with `--legacy-peer-deps`. Upgrade to zod 4,
and if your own code isn't ready for zod 4's API, change its imports to
`zod/v3` (zod 4 ships the v3 API there), which keeps your schemas working
unchanged.

## Schema and migration

Twelve tables, all keyed by a plain-text `tenant_id` (no foreign keys, so no
other package is forced on you). Money is integer cents, ratios are basis
points (10 000 = 100%), instants are `timestamptz`.

| Table | What it holds |
| --- | --- |
| `estimator_settings` | One row per business: name, contact, tax, currency, quote rules, lead alerts, photo and AI settings, brand colour. |
| `estimator_products` | What you sell, with its measurement recipe, labor, pricing and range rule. |
| `estimator_components` | The supplies library: name, cost per supplier unit, supplier, SKU, note, your own reference (for a sync). |
| `estimator_product_components` | A supply on a product: how much, per what (`rampFt`, `job`, …), and whether it is bought whole. |
| `estimator_options`, `estimator_option_values` | Choices a customer (or staff) picks, each adding a price. |
| `estimator_estimates`, `estimator_estimate_items` | Leads, staff estimates and quotes, with each line's inputs, derivation, range, cost and photo reading. |
| `estimator_quote_tokens` | The SHA-256 of every quote link, with the quote version it was sent for. |
| `estimator_photos` | Photos kept for the business (the bytes are in your store). |
| `estimator_takeoffs` | Every photo reading: what the model saw (normalized), tokens, cost, who asked (hashed). Also the cache. |
| `estimator_client_keys` | Website keys, with the websites each works on. |

**Drizzle owns your migrations.** Point drizzle at the schema and generate:

```ts
// drizzle.config.ts
schema: ["./src/db/schema.ts", "./node_modules/@adminigloo/estimator/dist/schema.js", "./node_modules/@adminigloo/comms/dist/schema.js"],
```

```bash
npx drizzle-kit generate && npx drizzle-kit migrate
```

### Your migrations are owned by Prisma, Rails, Knex…

Another migration tool that owns the `public` schema will see these tables as
drift: Prisma's next `migrate dev` writes `DROP TABLE` for them, or asks to
reset the database. Keep them out of its sight, in **their own Postgres
schema**:

1. Create the schema and the tables once (a migration of your own tool that
   only runs this SQL, or by hand):

   ```sql
   CREATE SCHEMA IF NOT EXISTS adminigloo;
   SET search_path TO adminigloo;
   -- then the CREATE statements below
   ```

2. Give the estimator its own pool with that schema first on the path; nothing
   in the package names a schema, so every query lands there:

   ```ts
   import { Pool } from "pg";
   import { drizzle } from "drizzle-orm/node-postgres";
   const estimatorDb = drizzle(new Pool({ connectionString: process.env.DATABASE_URL, options: "-c search_path=adminigloo" }));
   createEstimatorHandlers({ db: estimatorDb, … });
   ```

Prisma (introspecting `public` only) never sees them. The full CREATE script
for the twelve tables (a test runs it and compares it with the package's
schema, so it can't drift from what the package queries):

<!-- fresh-install-sql -->
```sql
CREATE TABLE "estimator_settings" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "business_name" text NOT NULL DEFAULT '',
  "contact_email" text,
  "contact_phone" text,
  "lead_notify_emails" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "currency" text NOT NULL DEFAULT 'USD',
  "locale" text NOT NULL DEFAULT 'en-US',
  "time_zone" text NOT NULL DEFAULT 'UTC',
  "tax_rate_bp" integer NOT NULL DEFAULT 825,
  "quote_valid_days" integer NOT NULL DEFAULT 30,
  "follow_up_days" integer NOT NULL DEFAULT 3,
  "quote_footer" text,
  "default_labor_rate_cents" bigint NOT NULL DEFAULT 0,
  "contingency_bp" integer NOT NULL DEFAULT 0,
  "instant_estimates_enabled" boolean NOT NULL DEFAULT true,
  "photos_enabled" boolean NOT NULL DEFAULT true,
  "ai_daily_budget_cents" integer NOT NULL DEFAULT 100,
  "ai_per_requester_daily" integer NOT NULL DEFAULT 5,
  "brand_color" text,
  "sample_loaded_at" timestamp with time zone,
  "saved_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "estimator_settings_tenant_idx" ON "estimator_settings" ("tenant_id");

CREATE TABLE "estimator_products" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "category" text,
  "name" text NOT NULL,
  "description" text,
  "measurement_mode" text NOT NULL DEFAULT 'area',
  "recipe" text,
  "recipe_config" jsonb,
  "allow_multiple" boolean NOT NULL DEFAULT true,
  "multiple_label" text,
  "max_quantity" integer NOT NULL DEFAULT 10,
  "base_price" bigint NOT NULL DEFAULT 0,
  "price_per_sqft" bigint,
  "price_per_linear_ft" bigint,
  "labor_cost" bigint NOT NULL DEFAULT 0,
  "labor_hours_per_unit_milli" integer NOT NULL DEFAULT 0,
  "labor_setup_hours_milli" integer NOT NULL DEFAULT 0,
  "labor_rate_cents" bigint,
  "waste_bp" integer NOT NULL DEFAULT 0,
  "pricing_basis" text NOT NULL DEFAULT 'markup',
  "markup_bp" integer NOT NULL DEFAULT 0,
  "margin_bp" integer NOT NULL DEFAULT 0,
  "minimum_charge" bigint NOT NULL DEFAULT 0,
  "range_mode" text NOT NULL DEFAULT 'percent',
  "contingency_bp" integer,
  "estimate_low_bp" integer NOT NULL DEFAULT 9000,
  "estimate_high_bp" integer NOT NULL DEFAULT 11500,
  "show_in_estimator" boolean NOT NULL DEFAULT true,
  "is_estimatable" boolean NOT NULL DEFAULT true,
  "sort_order" integer NOT NULL DEFAULT 0,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX "estimator_products_tenant_idx" ON "estimator_products" ("tenant_id", "is_active");

CREATE TABLE "estimator_components" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "name" text NOT NULL,
  "unit_type" text NOT NULL DEFAULT 'flat',
  "unit_cost" bigint NOT NULL DEFAULT 0,
  "supplier" text,
  "sku" text,
  "note" text,
  "external_ref" text,
  "managed_externally" boolean NOT NULL DEFAULT false,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX "estimator_components_tenant_idx" ON "estimator_components" ("tenant_id", "is_active");
CREATE UNIQUE INDEX "estimator_components_tenant_ref_uniq" ON "estimator_components" ("tenant_id", "external_ref");

CREATE TABLE "estimator_product_components" (
  "id" text PRIMARY KEY,
  "product_id" text NOT NULL,
  "component_id" text NOT NULL,
  "quantity_milli" integer NOT NULL DEFAULT 1000,
  "per" text,
  "round_up" boolean NOT NULL DEFAULT false,
  "sort_order" integer NOT NULL DEFAULT 0,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX "estimator_product_components_product_idx" ON "estimator_product_components" ("product_id");

CREATE TABLE "estimator_options" (
  "id" text PRIMARY KEY,
  "product_id" text NOT NULL,
  "name" text NOT NULL,
  "option_type" text NOT NULL DEFAULT 'custom',
  "show_in_estimator" boolean NOT NULL DEFAULT true,
  "sort_order" integer NOT NULL DEFAULT 0,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX "estimator_options_product_idx" ON "estimator_options" ("product_id");

CREATE TABLE "estimator_option_values" (
  "id" text PRIMARY KEY,
  "option_id" text NOT NULL,
  "label" text NOT NULL,
  "price_modifier" bigint NOT NULL DEFAULT 0,
  "is_default" boolean NOT NULL DEFAULT false,
  "sort_order" integer NOT NULL DEFAULT 0,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX "estimator_option_values_option_idx" ON "estimator_option_values" ("option_id");

CREATE TABLE "estimator_estimates" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "estimate_number" text NOT NULL,
  "status" text NOT NULL DEFAULT 'draft',
  "customer_name" text,
  "customer_email" text,
  "customer_phone" text,
  "job_address" text,
  "subtotal" bigint NOT NULL DEFAULT 0,
  "tax_rate_bp" integer NOT NULL DEFAULT 825,
  "tax_amount" bigint NOT NULL DEFAULT 0,
  "discount" bigint NOT NULL DEFAULT 0,
  "total" bigint NOT NULL DEFAULT 0,
  "range_low" bigint NOT NULL DEFAULT 0,
  "range_high" bigint NOT NULL DEFAULT 0,
  "range_reasons" jsonb,
  "currency" text NOT NULL DEFAULT 'USD',
  "cost" bigint,
  "notes" text,
  "internal_notes" text,
  "source" text NOT NULL DEFAULT 'staff',
  "photo_url" text,
  "quote_message" text,
  "quote_sequence" integer NOT NULL DEFAULT 0,
  "valid_until" timestamp with time zone,
  "sent_at" timestamp with time zone,
  "viewed_at" timestamp with time zone,
  "responded_at" timestamp with time zone,
  "approved_at" timestamp with time zone,
  "rejected_at" timestamp with time zone,
  "expired_at" timestamp with time zone,
  "converted_at" timestamp with time zone,
  "archived_at" timestamp with time zone,
  "expiry_notified_at" timestamp with time zone,
  "response_name" text,
  "response_note" text,
  "created_by" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX "estimator_estimates_tenant_idx" ON "estimator_estimates" ("tenant_id", "status");
CREATE UNIQUE INDEX "estimator_estimates_tenant_number_uniq" ON "estimator_estimates" ("tenant_id", "estimate_number");
CREATE INDEX "estimator_estimates_tenant_created_idx" ON "estimator_estimates" ("tenant_id", "created_at");
CREATE INDEX "estimator_estimates_tenant_valid_idx" ON "estimator_estimates" ("tenant_id", "status", "valid_until");

CREATE TABLE "estimator_estimate_items" (
  "id" text PRIMARY KEY,
  "estimate_id" text NOT NULL,
  "product_id" text,
  "description" text NOT NULL,
  "measurement" jsonb,
  "quantity" integer NOT NULL DEFAULT 1,
  "unit_price" bigint NOT NULL DEFAULT 0,
  "labor_price" bigint NOT NULL DEFAULT 0,
  "total" bigint NOT NULL DEFAULT 0,
  "low_total" bigint NOT NULL DEFAULT 0,
  "high_total" bigint NOT NULL DEFAULT 0,
  "price_overridden" boolean NOT NULL DEFAULT false,
  "cost" bigint,
  "recipe" text,
  "inputs" jsonb,
  "derived" jsonb,
  "takeoff_id" text,
  "corrections" jsonb,
  "selected_options" jsonb,
  "option_snapshot" jsonb,
  "sort_order" integer NOT NULL DEFAULT 0,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX "estimator_estimate_items_estimate_idx" ON "estimator_estimate_items" ("estimate_id");

CREATE TABLE "estimator_client_keys" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "label" text NOT NULL,
  "key_prefix" text NOT NULL,
  "key_hash" text NOT NULL,
  "allowed_origins" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "revoked_at" timestamp with time zone,
  "last_used_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "estimator_client_keys_hash_idx" ON "estimator_client_keys" ("key_hash");
CREATE INDEX "estimator_client_keys_tenant_idx" ON "estimator_client_keys" ("tenant_id");

CREATE TABLE "estimator_quote_tokens" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "estimate_id" text NOT NULL,
  "token_hash" text NOT NULL,
  "quote_sequence" integer,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "estimator_quote_tokens_hash_idx" ON "estimator_quote_tokens" ("token_hash");
CREATE INDEX "estimator_quote_tokens_estimate_idx" ON "estimator_quote_tokens" ("tenant_id", "estimate_id");

CREATE TABLE "estimator_photos" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "estimate_id" text,
  "file_id" text NOT NULL,
  "url" text NOT NULL,
  "content_type" text NOT NULL,
  "size_bytes" integer NOT NULL,
  "width" integer NOT NULL,
  "height" integer NOT NULL,
  "sha256" text NOT NULL,
  "source" text NOT NULL DEFAULT 'public',
  "requester_hash" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "linked_at" timestamp with time zone
);
CREATE INDEX "estimator_photos_estimate_idx" ON "estimator_photos" ("tenant_id", "estimate_id");
CREATE INDEX "estimator_photos_hash_idx" ON "estimator_photos" ("tenant_id", "sha256");
CREATE INDEX "estimator_photos_created_idx" ON "estimator_photos" ("tenant_id", "created_at");
CREATE INDEX "estimator_photos_requester_idx" ON "estimator_photos" ("tenant_id", "requester_hash", "created_at");

CREATE TABLE "estimator_takeoffs" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "product_id" text NOT NULL,
  "recipe" text NOT NULL,
  "photo_hash" text NOT NULL,
  "photo_id" text,
  "status" text NOT NULL DEFAULT 'pending',
  "observation" jsonb,
  "confidence" text,
  "model" text,
  "input_tokens" integer NOT NULL DEFAULT 0,
  "output_tokens" integer NOT NULL DEFAULT 0,
  "cost_micros" bigint NOT NULL DEFAULT 0,
  "cost_estimated" boolean NOT NULL DEFAULT false,
  "requester_hash" text,
  "error" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "completed_at" timestamp with time zone
);
CREATE UNIQUE INDEX "estimator_takeoffs_photo_idx" ON "estimator_takeoffs" ("tenant_id", "product_id", "photo_hash");
CREATE INDEX "estimator_takeoffs_tenant_created_idx" ON "estimator_takeoffs" ("tenant_id", "created_at");
CREATE INDEX "estimator_takeoffs_requester_idx" ON "estimator_takeoffs" ("tenant_id", "requester_hash", "created_at");
```

With `./comms`, its three tables, in the same schema:

```sql
CREATE TABLE "comms_templates" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "key" text NOT NULL,
  "channel" text NOT NULL DEFAULT 'email',
  "subject" text,
  "body" text NOT NULL,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "comms_templates_tenant_key_idx" ON "comms_templates" ("tenant_id", "key");

CREATE TABLE "comms_messages" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "channel" text NOT NULL,
  "to_address" text NOT NULL,
  "template_key" text,
  "subject" text,
  "body" text NOT NULL,
  "status" text NOT NULL,
  "error" text,
  "provider_id" text,
  "missing_vars" jsonb,
  "scheduled_id" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX "comms_messages_tenant_idx" ON "comms_messages" ("tenant_id", "created_at");
CREATE INDEX "comms_messages_recipient_idx" ON "comms_messages" ("tenant_id", "to_address", "template_key", "created_at");
CREATE INDEX "comms_messages_scheduled_idx" ON "comms_messages" ("scheduled_id");

CREATE TABLE "comms_scheduled" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "channel" text NOT NULL DEFAULT 'email',
  "to_address" text NOT NULL,
  "template_key" text NOT NULL,
  "vars" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "send_at" timestamp with time zone NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "ref_type" text,
  "ref_id" text,
  "dedupe_key" text,
  "min_interval_ms" bigint,
  "expires_at" timestamp with time zone,
  "attempts" integer NOT NULL DEFAULT 0,
  "last_error" text,
  "claimed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX "comms_scheduled_due_idx" ON "comms_scheduled" ("status", "send_at");
CREATE INDEX "comms_scheduled_ref_idx" ON "comms_scheduled" ("tenant_id", "ref_type", "ref_id");
CREATE UNIQUE INDEX "comms_scheduled_dedupe_idx" ON "comms_scheduled" ("tenant_id", "dedupe_key") WHERE "dedupe_key" IS NOT NULL;
```

## How prices are built

A product's price comes from what the business actually pays. For one set of
quantities (the recipe's, below):

1. **Supplies per item**: each supply's cost × its quantity per unit of
   measure × the quantity (`per` = a measurement like `rampFt`, or `item`). A
   supply marked **bought whole** (`roundUp`, on by default for an "each"
   supply) is rounded UP to whole units per item first: a post every 4 ft on a
   21-ft ramp is 6 posts, not 5.25.
2. **Other costs** (0.2's base price and per-unit rates), once per item.
3. **Supplies per job** (`per` = `job`): once.
4. **Waste** % on what is bought by the foot or square foot (not a permit, a
   delivery, a landing, or anything bought whole: rounding up is the spare).
5. **Labor**: hours per unit of measure × the rate (× items), plus setup hours
   once. The rate is the product's, else the settings' default. Hours at a $0
   rate are flagged in the admin ("labor is priced at $0").
6. **Cost** = all of the above.
7. **Price** = cost × (1 + markup), or cost ÷ (1 − target margin).
8. **Options** are added after markup: a "+$120" option adds $120.
9. Never below the **minimum**.

The worked example (the sample "Modular aluminum ramp": aluminum section
$95.00/ft, handrail $18.00 × 2 per ft, a post every 4 ft at $42.00 (bought
whole), a top landing $640, a resting landing $640 each, permit $150 and
delivery $85 per job, 0.35 h per ft + 2 h setup at $65/h, 5% waste, 40%
markup, $1,500 minimum):

| Ramp | Section + handrail | Waste | Posts (whole) | Job + landings | Labor + setup | Cost | Price |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 21 ft | $2,751.00 | $137.55 | 6 × $42 = $252.00 | $875.00 | $607.75 | $4,623.30 | **$6,472.62** |
| 23 ft | $3,013.00 | $150.65 | 6 × $42 = $252.00 | $875.00 | $653.25 | $4,943.90 | **$6,921.46** |
| 24 ft | $3,144.00 | $157.20 | 6 × $42 = $252.00 | $875.00 | $676.00 | $5,104.20 | **$7,145.88** |
| 32 ft, 1 landing | $4,192.00 | $209.60 | 8 × $42 = $336.00 | $1,515.00 | $858.00 | $7,110.60 | **$9,954.84** |

**The range is the measurement's own uncertainty, priced** (not a flat
percentage). "3 steps, height unknown" is 7–8 in a step → 21–24 in of rise →
priced at 21 ft and at 24 ft: **$6,472.62 – $7,145.88**. The line is saved,
and quoted, at the owner's **typical** step, 7.5 in (the middle of the band):
22.5 in → 23 ft, **$6,921.46**, never at the cheapest end of its own range.
"3 steps × 7.5 in" is that one number. An owner can add a contingency %
(default 0) that widens what is shown, never the price. A product can still
use 0.2's percentage band ("Percentage band (older)"); then the line is saved
at the band's midpoint.

The admin's **Test a quote** shows every line of the cost, the price and the
margin; the product list shows each product's price for an everyday answer
("3 steps: $6,921, margin 28.6%"). Customers only ever see prices: a cost, a
supply price, a markup or a margin never leaves the server on a public route,
and staff without `estimator.costs.view` see prices only (and can test the
saved product, not unsaved price changes).

### Already have a price list?

If your business already keeps what things cost in your own system (a
`services` table, an ERP), feed the supplies FROM it instead of keeping two
lists. A nightly job, by your own reference (a SKU, a service code):

```ts
import { upsertComponentByRef } from "@adminigloo/estimator";

for (const row of await db.select().from(services)) {
  await upsertComponentByRef(estimatorDb, tenantId, row.code, {
    name: row.name,
    unitType: "per_unit",          // per_linear_ft | per_sqft | per_unit | flat
    unitCost: row.costCents,       // what the business PAYS: markup goes on top
    supplier: "Our price list",
  });
}
```

One statement per row (`ON CONFLICT (tenant_id, external_ref) DO UPDATE`), so
a re-run changes nothing and two runs can't make two rows. A synced supply is
**managed outside**: the price book shows where its cost comes from and
refuses a cost change there (`managed_externally`), so the next sync never
silently undoes an owner's edit. Attach each supply to products once, in the
price book; every price using it moves when the sync changes its cost.
`getComponentByRef` reads one back. Going the other way, the staff handler's
`onPriceBookChange` hears every saved change (`{ tenantId, kind: "product" |
"supply" | "sample", id, action, userId }`) for a host that mirrors the price
book into its own records.

If your list holds SELL prices rather than costs, put them on the product
(Price → Other costs, or a supply with a 0% markup) knowing the admin will
then show a 0% margin.

## What customers are asked

Each product has a **recipe**: the questions a customer can answer with their
eyes or a tape measure, and the code that turns the answers into what is
priced. The widget shows the server's fields and sentences exactly; it never
works anything out itself.

| Recipe | The customer is asked | The code works out |
| --- | --- | --- |
| **Steps up to a door (ramp)** | "How many steps go up to the door?" (required; "2 steps and the porch is 3"), "Height of one step (optional)", and behind "More ways to measure", the total height | rise = steps × height; feet of ramp at the slope (ADA 1:12: a foot of ramp per inch of rise), rounded up to whole feet; a resting landing for every 30 in of rise |
| **Width × length** | Width and length (in feet, or inches), or a common size | square feet and the edge |
| **A length** | One length they can measure | feet |
| **A count** | "How many?" in the owner's words ("How many doorways need one?") | the count |

**Without a measured height**, the owner's step height band is used (default
7–8 in, typical 7.5), and the price says so plainly: "Based on an estimated
step height of 7–8 in. Measure one step and enter it for a tighter estimate."
With a height (or the total), the range collapses to one number. A total that
can't be the steps given (under 4.5 or over 9 in a step: "3" meant as 3 feet)
is questioned on its field, never silently priced. No text a customer reads
for a ramp mentions a "length of run".

"How many ramps?" is shown only for a product the owner marks as sold in
multiples. Every label, help text, the typical step height and its range,
whether the photo's step height is used, the slope, the rounding, the landing
rule, what the photo should show and the photo tip are the owner's to change
in the price book, with a live preview of exactly what the customer will be
asked.

## Photos

**Kept for the business.** A customer's photo (and any staff add) is stored
through a `photoStore` you pass in, linked to the estimate on submit, and shown
in the editor. A visitor may leave at most 12 photos a day that they never
send (the business at most 500; `photoLimits` on the handler), counted in the
database. Unsubmitted photos are deleted after 48 hours (`purgeOrphanPhotos`,
from the cron; pass `timeBudgetMs` and it keeps going, a batch at a time,
until they are gone or the time is up).

```ts
const photoStore: EstimatorPhotoStore = {
  put: async ({ tenantId, bytes, contentType, filename }) => {/* save; return { fileId, url } */},
  delete: async ({ tenantId, fileId }) => {/* remove */},
  urlFor: ({ url }) => url, // optional: a signed URL for staff
};
```

**The AI does no math.** The model is asked only to count risers and judge one
riser's height, and answers a tiny strict JSON
(`{"seen":true,"risers":3,"riserHeightIn":{"low":7.5,"high":8.5},"confidence":"medium"}`).
The code checks it, pre-fills the count, and does the rest. A low-confidence
height is never priced from, and a photo's height is kept inside the owner's
own band: 7.5–8.5 in on a 7–8 in band prices 7.5–8; a 9–12 in guess prices the
owner's 7–8 and says what the photo showed. The owner can switch the photo's
height off ("the photo fills the count only").

**As cheap as possible.** Claude Haiku 4.5 by default (`claude-haiku-4-5`, $1 /
$5 per million tokens); the browser shrinks the photo to ≤ 768 px first; a few
short prompt lines; 150 output tokens at most; no thinking; one try, 12
seconds at most. That is about **$0.001 a photo** (run the eval below for the
real figure on your photos). And:

- the same photo for the same product is **read once** (the cache);
- **no reading at all** when the customer has already typed the measurement;
- a **daily budget** per business (default $1.00) and a **daily cap per
  person** (default 5): both fail closed with "please count the steps and
  enter the number". A reading in progress counts against the budget at the
  most it can cost, so a burst of visitors can't overrun it;
- every call is a row with its tokens and cost, and `recordUsage` hears it.

```ts
import Anthropic from "@anthropic-ai/sdk";
import { createAnthropicTakeoffRunner } from "@adminigloo/estimator/anthropic";
const takeoff = { model: createAnthropicTakeoffRunner({ client: new Anthropic() }), recordUsage };
```

Give the route at least 30 seconds (`maxDuration` on Vercel): a reading gives
up after 12.

**The accuracy eval** (`eval/takeoff/`, not published, never run by `pnpm test`):
`node eval/takeoff/run.mjs --yes` reads a set of photos (the founder's porch —
two steps and a deck, three risers — and others you add) and reports how often
the count and the height were right, and what each photo cost. Without `--yes`
it only shows what it would send and cost, and how many real photos it found.
It shrinks photos exactly as the widget does (with `sharp`, a dev dependency)
and refuses to run without it. See `eval/takeoff/README.md`.

## Quotes

- **Send** (`sendQuote`): a draft with lines and the customer's email becomes
  `sent`, good for `quoteValidDays` (or what staff choose). The customer is
  emailed a link to `/quote/[token]`. Refused (`settings_incomplete`) until the
  business has saved its name. The estimate's `sendWarnings` name, BEFORE the
  send, every line still showing a range and what it is priced at ("Line 1 is
  priced at 3 steps, 7.5 in each (estimated), 23 ft of ramp. The range was
  $6,473 – $7,146…"); the quote's line says the same basis.
- **The link** opens the quote with no account: the business's name, the lines,
  the total with tax, the date it's good until, Accept / Decline with a note.
  Only hashes of the links are stored; every email mints its own.
- **Versions.** Every send is a new version (`PublicQuote.version`). An
  answer names the version the customer saw, and an accept from a page showing
  an older one is refused (`quote_changed`) with the new one shown. A link from
  before the quote was sent again stops working, so a quote emailed to the wrong
  address is cut off by correcting the address and sending it again.
- **First view** marks it `viewed`. **Accept / decline** is one atomic update: a
  double tap accepts once; a decline after an accept is refused; past its date
  it expires and says to call.
- **Revise** takes a sent quote back to a draft (its link says "We're updating
  this quote"); send it again when ready. **Resend** emails a fresh link
  without changing the date or the version.
- **Follow-up**: N days after sending (`followUpDays`, default 3), if nobody has
  answered. Withdrawn on any answer, revise or expiry.
- **Expiry**: `expireQuotes` (the cron, the admin, and lazily on view). Each
  expiry is announced and then stamped; a run cut off part-way leaves the rest
  for the next run (`timeBudgetMs` stops it cleanly), so no customer or office
  goes untold.

## Settings

`getEstimatorSettings` / `updateEstimatorSettings`, one row per business:
business name, contact email and phone, lead alert addresses (up to 5),
currency, locale, time zone, tax rate (0–30%), quote validity, follow-up days,
quote footer, default labor rate, default contingency, instant estimates on/off,
photos on/off, the daily AI budget and per-person cap, brand colour. A business
that never saved settings reads the defaults (8.25% tax, UTC) and — until a
save with the business's name — takes no leads and sends no quote
(`estimatorReady`, `publicEstimatesOpen`). The admin's notices say so, and what
else is left: a product that prices at $0, labor hours at a $0 rate, no
product on the website yet, photo reading off and why.

## HTTP handlers

Both are one `handle(req)` routed by path suffix; mount each at any base with a
catch-all route.

```ts
// app/api/estimator/[...path]/route.ts — the website (and the embed on other sites)
const { handle } = createEstimatorHandlers({ db, tenantId: "primary", photoStore, takeoff, onEvent, rateLimit, requesterKey });
export { handle as GET, handle as POST, handle as OPTIONS };

// app/api/admin/estimator/[...path]/route.ts — staff
const { handle } = createEstimatorAdminHandlers({ db, tenantId: "primary", authorize, photoStore, photoReading: true, onEvent, quoteUrl });
```

**Public** (`{base}/v1/…`): `GET config`, `POST options`, `POST calculate`
(never calls the model), `POST photo` (201), `POST takeoff`, `POST submit`
(201), `GET quote/:token`, `POST quote/:token/accept`, `POST quote/:token/decline`
(both with `version`). With `x-adminigloo-key` it serves the embed on the
business's own website: the key's allowed websites are checked and CORS
answers that page. Without a key it serves the business's own pages
(same-origin, every POST checked against cross-site requests). The lead form's
honeypot and minimum fill time run before any database work.

**The rate limit.** `rateLimit(req, bucket, { tenantId, keyId })` is asked per
bucket (`read`, `calculate`, `photo`, `takeoff`, `submit`, `respond`); `false`
or a throw is a 429. **Without `rateLimit` every public route is unlimited**:
only the AI budget, the per-visitor reading count and the photo cap (all in
the database) still hold. The smallest one, per instance:

```ts
const hits = new Map<string, number[]>();
const LIMITS = { read: 120, calculate: 120, photo: 20, takeoff: 10, submit: 5, respond: 10 } as const; // per hour
const rateLimit = (req: Request, bucket: keyof typeof LIMITS) => {
  const key = `${bucket}:${clientIpKey(req) ?? "none"}`;
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < 3_600_000);
  recent.push(now);
  hits.set(key, recent);
  return recent.length <= LIMITS[bucket];
};
```

Use a shared store (Redis, Upstash) when you run more than one instance.

**Who is asking.** `requesterKey(req)` names the visitor for the per-person
reading count and the photo cap. The default, `clientIpKey`, reads the address
your nearest proxy appended to `X-Forwarded-For`. Match it to what sits in
front of your app:

| In front of the app | `requesterKey` |
| --- | --- |
| Vercel, or one proxy (nginx, a load balancer) | the default (`clientIpKey`) |
| Two proxies, each appending (Cloudflare → nginx) | `createClientIpKey({ trustProxy: 2 })` |
| Cloudflare, every request through it | `createClientIpKey({ cloudflare: true })` (reads `CF-Connecting-IP`) |
| A Cloudflare tunnel to the app | `createClientIpKey({ cloudflare: true })` |
| Nothing (a laptop, a test) | the default: no address, so `null` |

A request it can't place (`null`) shares **one shared bucket** with every other
such request: behind a proxy you haven't told it about, every visitor counts as
the same person and is refused after a few readings. `cloudflare: true` is only
for an app that really can't be reached except through Cloudflare (anyone else
can send that header).

**Staff** (`{base}/v1/admin/…`): status, usage, settings, products (and their
supplies, options, reorder, preview), supplies, the sample catalog, estimates
(search, create, edit lines, photos, send, resend, revise, status, link,
archive, duplicate, convert), expire, website keys. Each route asks
`authorize(req, permission, tenantId)` for one permission
(`ESTIMATOR_ADMIN_ROUTE_PERMISSIONS`); routes that can carry a cost also ask
`estimator.costs.view` and strip costs, markups, margins and the default labor
rate without it. `photoReadingOff` ("not_installed", "no_key",
"model_unpriced") words the "photo reading is off" notice. No CORS, ever.

**The wire.** Every request and response body is a TypeScript type the package
exports (`import type { CalculateBody, CalculateResponse, PublicQuote, … } from
"@adminigloo/estimator"`, from `src/wire.ts`): a host writing its own
transport (server actions, tRPC) builds against those. Errors are `{ error: {
code, message, issues? } }`; `WIRE_ERROR_STATUS` maps each code to its HTTP
status. An unexpected error is a 500 with a fixed message, reported to
`onError`, never its own text.

## Emails (`./comms`)

```ts
import { createEstimatorCommsListener } from "@adminigloo/estimator/comms";
const estimatorComms = createEstimatorCommsListener({
  db, senders,
  quoteUrl: (token) => `${APP_URL}/quote/${token}`,
  adminEstimateUrl: (id) => `${APP_URL}/admin/estimates/${id}`,
  bookUrl: (estimate) => `${APP_URL}/book-visit?estimate=${estimate.id}`,
  followUpRuns: { dailyAtUtc: "14:00" },   // when your cron runs (below)
});
// onEvent: estimatorComms.onEvent on both handlers.
```

| Event | Customer | Office |
| --- | --- | --- |
| A lead | a copy of their estimate | "New lead: Pat Lee, $8,610 – $9,955" with why it's a range, the photo reading, what the customer changed, the photo count, a link |
| Quote sent | the quote, with its link | — |
| Accepted | thanks, and the next step (book the visit) | "Quote accepted", with their note |
| Declined | — | "Quote declined", with their note |
| Expired | that it expired | "Quote expired" |

Seven templates (`estimate_lead_customer`, `estimate_lead_staff`, `quote_sent`,
`quote_follow_up`, `quote_accepted_customer`, `quote_expired_customer`,
`quote_staff_notice`), inserted once per business and never overwritten, so an
owner's edits in the comms admin stay. Office emails go to the lead alert
addresses (or `staffEmails`), never for a change staff made themselves.
Anything a visitor typed (name, address, notes, an accept note) is one line
with any link broken, in the office's emails as much as the customer's.

### The cron

One route, called once a day (or more often), with a shared secret:

```ts
// app/api/cron/estimator/route.ts
export const maxDuration = 60;
export async function POST(req: Request) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("unauthorized", { status: 401 });
  }
  try {
    await runDueMessages(db, senders, { beforeSend: async (row) => (await estimatorComms.beforeSend(row)) ?? "send" });
  } finally {
    await estimatorComms.redactSent();
  }
  const expired = await expireQuotes(db, tenantId, { onEvent: estimatorComms.onEvent, timeBudgetMs: 20_000 });
  const photos = await purgeOrphanPhotos(db, photoStore, { timeBudgetMs: 20_000 });
  return Response.json({ expired: expired.expired, announced: expired.announced, photosDeleted: photos.deleted });
}
```

Refuse every call while `CRON_SECRET` is unset, or a stranger can send your
follow-ups. Vercel Cron sends `Authorization: Bearer $CRON_SECRET` itself.
Anywhere else, a scheduler calls it, for example GitHub Actions:

```yaml
# .github/workflows/estimator-cron.yml
on:
  schedule:
    - cron: "0 14 * * *"   # 14:00 UTC
jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - run: curl -fsS -X POST -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}" https://your-site.example/api/cron/estimator
```

Tell the listener when that is (`followUpRuns: { dailyAtUtc: "14:00" }`, or
`{ everyMinutes: 15 }`): a follow-up goes on the last run at or before its
day. GitHub's schedules can run late, or be skipped when GitHub is busy; a
follow-up then goes on the next run, and nothing is lost (expiries that
weren't announced are announced next time).

`beforeSend` re-checks a follow-up at send time (answered, revised, expired →
skipped) and adds a fresh link; `redactSent` scrubs every link from the
delivery log.

## Events

`lead.received`, `quote.sent`, `quote.viewed`, `quote.accepted`,
`quote.declined`, `quote.expired`, `quote.revised`, `estimate.converted`: one
envelope (`{ id, type, tenantId, estimateId, occurredAt, actor, data: {
estimate, notify, via?, note? } }`), delivered **after commit**, awaited in
order, contained (a throwing listener never fails the action), with no link,
key, cost or internal note in it, and none for a no-op.

## Permissions

`estimatorPermissions` (tenant keys, for your `definePermissions`):
`estimator.view` (everyone), `estimator.estimates.manage` (owner, admin,
member), `estimator.costs.view` (owner, admin), `estimator.pricebook.manage`
(owner, admin), `estimator.settings.manage` (owner, admin).

## Booking the visit and invoicing

`createEstimatorAdminHandlers` takes `links.bookVisitUrl` (scheduling 0.4's
`VisitPicker` with `estimateId`), `links.visits`, `links.invoice`, and
`convertToInvoice` — your function that, in one transaction, builds the
invoice (`invoiceInputFromEstimate` from `@adminigloo/invoicing`) and calls
`markEstimateConverted`. An accepted quote then offers "Book the visit" and
"Make an invoice".

## Companies (Tenancy 2a)

One deployment quotes for many companies. Everything below is optional:
without it, 0.4 behaves exactly as 0.3 for one business.

| Option | On | What it does |
| --- | --- | --- |
| `company(tenantId)` | both handlers, the comms listener, `resolveEstimatorSettings` | The business's name, time zone, contact details, logo and colour from the host's company profile. They override the estimator's own; the settings screen shows them read-only under "These come from your company settings." (`companySettingsHref`). A throw is reported and treated as no company for that request. |
| `admit(tenantId, req)` | public handlers | Asked once per request on BOTH paths, the web address and the website embed key, before any other work. `{ open: false, message }` answers 409 `estimates_closed` with that sentence. |
| `aiBudgetCeilingCents` | both handlers | The site's ceiling on photo-reading spend per company per day: the budget a reading checks is the lower of the company's own setting and this, applied before any photo is read. The settings screen says "Up to $x.xx a day on this site." Default: no ceiling. |
| `quoteUrl`, `links.bookVisitUrl` | staff handlers, comms listener | May be async: links are built from the company's web address. |
| `staffEmails` | comms listener | A list, or `(tenantId) => list`: where "new estimate" notices go. With tenancy: the company's own inbox. A reply to one reaches the customer it is about. |
| `invoiceAccess(req, need, tenantId)` | staff handlers | The host's INVOICE permission, asked beside the estimator's own: "Turn into an invoice" needs `"manage"` (else 403 "You can't raise invoices…"), and an estimate's page shows the invoice it became only with `"view"`. Same answers as `authorize`. Without it, the estimator's own permission decides. |
| `aiSiteBudgetCents` | public handlers | A daily ceiling on photo reading for EVERY business the handler serves together, beside each one's own: past it, every business's reading pauses until tomorrow (UTC). Default: none. |
| `siteNotices: "company"` | staff handlers | The site's own setup gaps (no AI key, no file storage) in a company's words — "isn't available on this site yet" — never a setting it can't change. |

Under a path that names its company (`resolveTenant`), an embed key counts only
if it is THAT company's: another company's key is "not found", and its "last
used" is left alone (`verifyClientKey(db, key, { tenantId })`). The web address
decides, never the key.

The sample price book comes for a trade: `loadSampleCatalog(db, tenantId, {
trade: "lawn" | "cleaning" | "ramps" })` (the route takes `{ trade }`; none is
0.3's ramps sample), and `SAMPLE_CATALOGS` holds all three.

**Route tables and checklist items.** `ESTIMATOR_ADMIN_ROUTES` and
`ESTIMATOR_PUBLIC_ROUTES` list every route with its permission (another
company's id in a path answers 404). `estimatorChecklistItems({ priceBook,
settings, embed })` gives the setup steps ("Add the work you sell and its
prices", "Set your tax rate and quote rules", …) for tenancy's checklist.

With `@adminigloo/tenancy`:

```ts
import { createEstimatorAdminHandlers, createEstimatorHandlers } from "@adminigloo/estimator";
import { createEstimatorCommsListener } from "@adminigloo/estimator/comms";
import { createCompanyRouteSeams, createPublicCompanySeams } from "@adminigloo/tenancy/server";

const company = (id: string) => tenancy.companyProfile(id);
const quoteUrl = async (token: string, id: string) => `${origin}${(await company(id))?.publicPath}/quote/${token}`;
const AI_CEILING = 500; // $5.00 a day per company
const listener = createEstimatorCommsListener({
  db, senders, quoteUrl, company,
  staffEmails: async (id) => (await company(id))?.inbox ?? [],
});

const pub = createPublicCompanySeams({ tenancy });               // /api/t/{web address}/estimator/…
export const publicEstimator = createEstimatorHandlers({
  db, resolveTenant: pub.resolveTenant, admit: pub.admit, company,
  aiBudgetCeilingCents: AI_CEILING, photoStore, takeoff, onEvent: listener.onEvent,
});

const seams = createCompanyRouteSeams({ tenancy, principal: (req) => getSignedInUser(req) });   // /api/app/{id}/estimator/…
export const staffEstimator = createEstimatorAdminHandlers({
  db, resolveTenant: seams.resolveTenant, authorize: seams.authorize, company,
  companySettingsHref: "/app/settings#company",
  aiBudgetCeilingCents: AI_CEILING, quoteUrl, photoStore, onEvent: listener.onEvent,
});
```

An embed key names its own company, so a request through the key skips
`resolveTenant`; `admit` still runs for it (a suspended company's website
widget says it isn't taking estimates).

**A foreign host** passes its own `resolveTenant(req)`,
`authorize(req, permission, tenantId)` (returning `{ userId }`, `false`, or a
`Response`), `admit`, `company` and `staffEmails` from its own tables.

## Upgrading from 0.2

Run your migration generator (`drizzle-kit generate` and `migrate`). For a host
not on drizzle, the statements are:

```sql
ALTER TABLE "estimator_products" ADD COLUMN "recipe" text;
ALTER TABLE "estimator_products" ADD COLUMN "recipe_config" jsonb;
ALTER TABLE "estimator_products" ADD COLUMN "allow_multiple" boolean NOT NULL DEFAULT true;
ALTER TABLE "estimator_products" ADD COLUMN "multiple_label" text;
ALTER TABLE "estimator_products" ADD COLUMN "max_quantity" integer NOT NULL DEFAULT 10;
ALTER TABLE "estimator_products" ADD COLUMN "labor_hours_per_unit_milli" integer NOT NULL DEFAULT 0;
ALTER TABLE "estimator_products" ADD COLUMN "labor_setup_hours_milli" integer NOT NULL DEFAULT 0;
ALTER TABLE "estimator_products" ADD COLUMN "labor_rate_cents" bigint;
ALTER TABLE "estimator_products" ADD COLUMN "pricing_basis" text NOT NULL DEFAULT 'markup';
ALTER TABLE "estimator_products" ADD COLUMN "margin_bp" integer NOT NULL DEFAULT 0;
ALTER TABLE "estimator_products" ADD COLUMN "range_mode" text NOT NULL DEFAULT 'percent';
ALTER TABLE "estimator_products" ADD COLUMN "contingency_bp" integer;
ALTER TABLE "estimator_components" ADD COLUMN "supplier" text;
ALTER TABLE "estimator_components" ADD COLUMN "sku" text;
ALTER TABLE "estimator_components" ADD COLUMN "note" text;
ALTER TABLE "estimator_components" ADD COLUMN "external_ref" text;
ALTER TABLE "estimator_components" ADD COLUMN "managed_externally" boolean NOT NULL DEFAULT false;
ALTER TABLE "estimator_components" ADD COLUMN "updated_at" timestamp with time zone NOT NULL DEFAULT now();
CREATE UNIQUE INDEX "estimator_components_tenant_ref_uniq" ON "estimator_components" USING btree ("tenant_id","external_ref");
ALTER TABLE "estimator_product_components" ADD COLUMN "per" text;
ALTER TABLE "estimator_product_components" ADD COLUMN "round_up" boolean NOT NULL DEFAULT false;
ALTER TABLE "estimator_product_components" ADD COLUMN "sort_order" integer NOT NULL DEFAULT 0;
ALTER TABLE "estimator_estimates" ADD COLUMN "range_low" bigint NOT NULL DEFAULT 0;
ALTER TABLE "estimator_estimates" ADD COLUMN "range_high" bigint NOT NULL DEFAULT 0;
ALTER TABLE "estimator_estimates" ADD COLUMN "range_reasons" jsonb;
ALTER TABLE "estimator_estimates" ADD COLUMN "currency" text NOT NULL DEFAULT 'USD';
ALTER TABLE "estimator_estimates" ADD COLUMN "cost" bigint;
ALTER TABLE "estimator_estimates" ADD COLUMN "quote_message" text;
ALTER TABLE "estimator_estimates" ADD COLUMN "quote_sequence" integer NOT NULL DEFAULT 0;
ALTER TABLE "estimator_estimates" ADD COLUMN "valid_until" timestamp with time zone;
ALTER TABLE "estimator_estimates" ADD COLUMN "sent_at" timestamp with time zone;
ALTER TABLE "estimator_estimates" ADD COLUMN "viewed_at" timestamp with time zone;
ALTER TABLE "estimator_estimates" ADD COLUMN "responded_at" timestamp with time zone;
ALTER TABLE "estimator_estimates" ADD COLUMN "approved_at" timestamp with time zone;
ALTER TABLE "estimator_estimates" ADD COLUMN "rejected_at" timestamp with time zone;
ALTER TABLE "estimator_estimates" ADD COLUMN "expired_at" timestamp with time zone;
ALTER TABLE "estimator_estimates" ADD COLUMN "converted_at" timestamp with time zone;
ALTER TABLE "estimator_estimates" ADD COLUMN "archived_at" timestamp with time zone;
ALTER TABLE "estimator_estimates" ADD COLUMN "expiry_notified_at" timestamp with time zone;
ALTER TABLE "estimator_estimates" ADD COLUMN "response_name" text;
ALTER TABLE "estimator_estimates" ADD COLUMN "response_note" text;
CREATE INDEX "estimator_estimates_tenant_created_idx" ON "estimator_estimates" USING btree ("tenant_id","created_at");
CREATE INDEX "estimator_estimates_tenant_valid_idx" ON "estimator_estimates" USING btree ("tenant_id","status","valid_until");
ALTER TABLE "estimator_estimate_items" ADD COLUMN "low_total" bigint NOT NULL DEFAULT 0;
ALTER TABLE "estimator_estimate_items" ADD COLUMN "high_total" bigint NOT NULL DEFAULT 0;
ALTER TABLE "estimator_estimate_items" ADD COLUMN "price_overridden" boolean NOT NULL DEFAULT false;
ALTER TABLE "estimator_estimate_items" ADD COLUMN "cost" bigint;
ALTER TABLE "estimator_estimate_items" ADD COLUMN "recipe" text;
ALTER TABLE "estimator_estimate_items" ADD COLUMN "inputs" jsonb;
ALTER TABLE "estimator_estimate_items" ADD COLUMN "derived" jsonb;
ALTER TABLE "estimator_estimate_items" ADD COLUMN "takeoff_id" text;
ALTER TABLE "estimator_estimate_items" ADD COLUMN "corrections" jsonb;
ALTER TABLE "estimator_client_keys" ADD COLUMN "allowed_origins" jsonb NOT NULL DEFAULT '[]'::jsonb;
```

Then the four new tables: `estimator_settings`, `estimator_quote_tokens`,
`estimator_photos` and `estimator_takeoffs`, exactly as in the CREATE script
above.

Then backfill the ranges of estimates made before 0.3, and mark expiries from
before 0.3 as already announced (or the first run would email every customer
whose quote ever lapsed):

```sql
UPDATE estimator_estimate_items SET low_total = total, high_total = total
WHERE low_total = 0 AND high_total = 0;
UPDATE estimator_estimates SET range_low = subtotal, range_high = subtotal
WHERE range_low = 0 AND range_high = 0;
UPDATE estimator_estimates SET expiry_notified_at = COALESCE(expired_at, updated_at)
WHERE status = 'expired' AND expiry_notified_at IS NULL;
```

Then **open the admin's Settings and save the business's name and tax rate**:
until then the website estimator says it isn't available and no quote can be
sent (0.2 used the handler's `taxRateBp` option; it is no longer consulted).

Nothing else: a product from before 0.3 (`recipe` null) keeps pricing exactly
as it did — its recipe follows its measurement mode (an area in inches), its
range stays the percentage band, "How many?" stays on, and its supplies
(`per` null, not rounded) scale by their own unit.

**To get 0.3's behaviour on a ramp product**, in the price book: set *How it's
measured* to "Steps up to a door (ramp)", set *Range* to "From the
measurement", and give each supply a *per* ("per ft of ramp", "once per job",
"per resting landing"). Then move the per-foot price you used to type into
supply lines and labor hours, and check it in *Test a quote*.

**Breaking (0.x minor):**

- The public estimator, the embed, the photo reading and `createPublicEstimate`
  are closed (`estimates_closed`) until the business has saved settings with
  its name; `sendQuote` and `resendQuote` refuse `settings_incomplete`. The
  handler's deprecated `taxRateBp` option has no effect any more.
- `loadSampleCatalog` loads the products OFF the website (`showInEstimator:
  false`); pass `{ showInEstimator: true }` for a demo.
- A public price that works out to $0 answers `quote_only`.
- Accepting or declining a quote takes the `version` the customer saw
  (`acceptQuote(db, tenant, token, { version, … })`; the HTTP bodies need
  `version`), and a link from before the latest send no longer opens the quote.
- `expireQuotes` answers `{ expired, estimateIds, announced }`, and every run
  also announces earlier unannounced expiries.
- The public submit ignores an item's `description` (the line is the
  product's name).
- `AdminProduct.wasteBp`, `markupBp` and `marginBp`, and the settings'
  `defaultLaborRateCents`, are null for a caller without
  `estimator.costs.view`; such a caller can't preview a draft that changes
  costs.
- The zod peer is `^4.0.0` (the types always were zod 4's).
- `buildTakeoffPrompt` and `TAKEOFF_SYSTEM_PROMPT` now ask for observations,
  not measurements; `parseTakeoff` and `TakeoffResult` are removed (use
  `normalizeObservation`).
- `createEstimatorHandlers`' `runTakeoff` option is removed: pass
  `takeoff: { model }` (`createAnthropicTakeoffRunner`), and the package runs
  the reading itself, with its cache, budget and limits.
- The embed's error body is `{ error: { code, message, issues? } }` (was
  `{ error: "product_unavailable" }`), and a server fault is a 500 (was 400).
  A submit answers 201 (was 200; `res.ok` still holds). Another business's
  product on `calculate` is a 400 `product_unavailable` (was
  `{ result: null }`).
- `ESTIMATE_STATUS_TRANSITIONS` gains sent / viewed → draft (revise).
- `createEstimateSchema.items` may be empty (a blank "New estimate").
- `getEstimate`'s answer type is now named `EstimateWithItems` (the wire's
  `EstimateDetail` is the admin view).

**Deliberate pricing changes:**

1. An option's price is added after markup (a "+$60" option at 25% markup
   used to add $75).
2. The low end of a range is never below the minimum (it showed $180 for a
   $200 minimum).
3. A measured-range line is saved at its point price (the typical step: the
   middle of the band), not a band midpoint. Percentage-band lines keep 0.2's
   midpoint.
4. A supply attached "each" through 0.3 is rounded up to whole units, with no
   waste on top.

## Tests

`pnpm test` runs on PGlite (real Postgres in WASM) and an in-memory fake for
0.2's suites; no network and no model calls. The acceptance test is
`src/__tests__/business-scenario.test.ts`; `review-fixes.test.ts` holds one
test per finding of the 2026-10-12 review.
