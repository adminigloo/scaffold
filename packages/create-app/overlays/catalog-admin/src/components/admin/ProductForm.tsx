"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  canPublish as catalogCanPublish,
  validateProduct,
  type GrantDraft,
  type GrantKind,
  type Problem,
  type ProductKind,
  type ProductStatus,
  type SyncPlan,
  type VariantDraft,
  type VariantInterval,
} from "__SCOPE__/catalog";
import { parseInventoryInput, parseMoneyInput } from "@/components/admin/money";
import {
  emptyVariantRow,
  grantConfigFor,
  VariantEditor,
  type VariantRow,
} from "@/components/admin/VariantEditor";
import { api } from "@/trpc/client";

/**
 * The product builder, for both /admin/products/new and /admin/products/[id].
 *
 * One component for both, because a create form and an edit form that diverge
 * end up with different validation, and the one that gets less use is the one
 * that ships a broken product. The only difference is that `create` has no id
 * yet, so it cannot publish, archive, or plan a Stripe sync until it is saved.
 *
 * COPIED SOURCE. Restyle it freely. What must NOT move in here is the
 * decision-making: `validateProduct` is the package's, run again on the server
 * in `catalog.publish`, and the sync plan comes back from `catalog.syncPlan`
 * already worked out. A browser holding its own copy of the rules is how a UI
 * ends up offering a button the API then refuses.
 */

export interface ProductFormInitialVariant {
  readonly id: string;
  readonly name: string;
  readonly sku: string | null;
  /** MAJOR units, as `minorToMajorInput` in ./money.ts writes them. */
  readonly priceInput: string;
  readonly currency: string;
  readonly interval: VariantInterval | null;
  readonly isDefault: boolean;
  readonly inventory: number | null;
  readonly grant: {
    readonly kind: GrantKind;
    readonly config: Readonly<Record<string, unknown>>;
  } | null;
}

export interface ProductFormInitial {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly kind: ProductKind;
  readonly status: ProductStatus;
  readonly sortOrder: number;
  readonly variants: readonly ProductFormInitialVariant[];
}

export interface ProductFormProps {
  /** Absent in create mode. */
  readonly initial?: ProductFormInitial;
  /**
   * Resolved on the server from the staff permission set.
   *
   * Presentation only, every one of them. The procedures re-check on each call,
   * because a prop is a hint from a page that has already rendered and the
   * mutation is reachable without it.
   */
  readonly canEditPrices: boolean;
  readonly canPublishProducts: boolean;
  readonly canArchiveProducts: boolean;
  /** What a new variant is priced in before anyone changes it. */
  readonly defaultCurrency?: string;
}

const FIELD =
  "w-full rounded-[--radius-card] border border-line bg-surface px-2.5 py-1.5 text-sm text-ink " +
  "placeholder:text-ink-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent " +
  "focus-visible:ring-offset-2 focus-visible:ring-offset-canvas disabled:cursor-not-allowed disabled:opacity-60";

const LABEL = "mb-1 block text-[11px] font-medium uppercase tracking-wider text-ink-muted";

const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent " +
  "focus-visible:ring-offset-2 focus-visible:ring-offset-canvas";

const PRIMARY =
  `rounded-[--radius-card] bg-accent px-3.5 py-2 text-sm font-medium text-white ${FOCUS} ` +
  "disabled:cursor-not-allowed disabled:opacity-50";

const SECONDARY =
  `rounded-[--radius-card] border border-line bg-surface px-3.5 py-2 text-sm text-ink ${FOCUS} ` +
  "disabled:cursor-not-allowed disabled:opacity-50";

/** Plain English for each planner action, beside the planner's own reason. */
const STEP_LABEL: Record<string, string> = {
  "create-product": "Creates a Stripe product",
  "update-product": "Updates the Stripe product",
  "create-price": "Creates a Stripe price",
  "archive-price-and-create":
    "Creates a NEW Stripe price and archives the old one",
  noop: "Nothing to do",
};

/** What `catalog.syncPlan` was last asked. Snapshotted, never live — see below. */
interface PlanSnapshot {
  readonly id: string;
  readonly product?: {
    readonly name?: string;
    readonly description?: string | null;
    readonly status?: ProductStatus;
  };
  // Mutable array, matching the procedure's inferred input type: zod's inferred
  // output is a mutable `[]`, and a `readonly []` is not assignable to it.
  readonly variants?: {
    readonly id: string;
    readonly priceMinor?: bigint;
    readonly currency?: string;
    readonly interval?: VariantInterval | null;
  }[];
}

export function ProductForm({
  initial,
  canEditPrices,
  canPublishProducts,
  canArchiveProducts,
  defaultCurrency = "usd",
}: ProductFormProps) {
  const router = useRouter();
  const utils = api.useUtils();

  const [slug, setSlug] = useState(initial?.slug ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [kind, setKind] = useState<ProductKind>(initial?.kind ?? "one_time");
  const [rows, setRows] = useState<readonly VariantRow[]>(() =>
    (initial?.variants ?? []).map(rowFromInitial),
  );
  const [removedIds, setRemovedIds] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState<null | "save" | "publish" | "archive">(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [planSnapshot, setPlanSnapshot] = useState<PlanSnapshot | null>(
    initial ? { id: initial.id } : null,
  );

  // Once the admin edits the slug by hand we stop deriving it. A slug that
  // keeps re-deriving from the name silently changes a URL that may already be
  // printed on something.
  const slugTouched = useRef(initial !== undefined);
  const newRowCounter = useRef(0);

  const create = api.catalog.create.useMutation();
  const update = api.catalog.update.useMutation();
  const upsertVariant = api.catalog.upsertVariant.useMutation();
  const removeVariant = api.catalog.removeVariant.useMutation();
  const setGrant = api.catalog.setGrant.useMutation();
  const publish = api.catalog.publish.useMutation();
  const archive = api.catalog.archive.useMutation();

  /**
   * The Stripe plan is fetched from a SNAPSHOT, not from live form state.
   *
   * The plan's whole value is that it can compare the unsaved price against the
   * saved one, so it has to see the edits — but a query keyed on live state
   * refires on every keystroke, and "12", "12.9", "12.99" are three different
   * plans nobody asked for. The button below takes one snapshot and the query
   * key changes once.
   */
  const plan = api.catalog.syncPlan.useQuery(planSnapshot ?? { id: "" }, {
    enabled: planSnapshot !== null,
  });

  // ---- validation, all of it, all the time --------------------------------
  const { problems, problemsByPath, moneyProblems, publishable } = useMemo(
    () => validateEverything({ slug, name, kind, rows }),
    [slug, name, kind, rows],
  );

  // `publishable` is the PACKAGE's rule, not `problems.length === 0` written
  // out again here. Two copies of it drift the moment someone decides one
  // problem is "only a warning", and the first warning anybody adds is always
  // the one that ships a broken price. The money failures sit alongside it
  // because `validateProduct` cannot see them — by the time it runs, the value
  // is already a bigint.
  const blocked = !publishable || moneyProblems.length > 0;
  const status = initial?.status ?? "draft";

  function patchRow(key: string, patch: Partial<VariantRow>) {
    setRows((current) =>
      current.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    );
  }

  function addRow() {
    newRowCounter.current += 1;
    const currency = rows[rows.length - 1]?.currency ?? defaultCurrency;
    setRows((current) => [
      ...current,
      emptyVariantRow(`new-${newRowCounter.current}`, currency, kind),
    ]);
  }

  function dropRow(key: string) {
    const row = rows.find((candidate) => candidate.key === key);
    const savedId = row?.id ?? null;
    // Only saved rows need a DELETE. An unsaved one has never existed anywhere
    // but this component's state.
    if (savedId !== null) setRemovedIds((current) => [...current, savedId]);
    setRows((current) => current.filter((candidate) => candidate.key !== key));
  }

  async function handleSave() {
    setFailure(null);
    setNotice(null);
    setBusy("save");

    // What has been written so far, so a failure halfway can say so. These
    // calls are sequential and not one transaction: `create` and
    // `upsertVariant` are separately permissioned on purpose, and wrapping them
    // in one procedure would let `catalog.products.create` alone set a price.
    let done = 0;

    try {
      const productFields = {
        slug: slug.trim(),
        name: name.trim(),
        description: description.trim() === "" ? null : description.trim(),
        kind,
      };

      const productId = initial
        ? (await update.mutateAsync({ id: initial.id, ...productFields })).id
        : (await create.mutateAsync(productFields)).id;
      done += 1;

      // Variants BEFORE removals, so replacing the only variant on an active
      // product works: `removeVariant` refuses to take the last one, and by
      // then the replacement exists.
      for (const [index, row] of rows.entries()) {
        const money = parseMoneyInput(row.priceInput, row.currency);
        const stock = parseInventoryInput(row.inventoryInput);
        if (!money.ok || !stock.ok) continue;

        const saved = await upsertVariant.mutateAsync({
          id: row.id ?? undefined,
          productId,
          name: row.name.trim(),
          sku: row.sku.trim() === "" ? null : row.sku.trim(),
          priceMinor: money.minor,
          currency: row.currency,
          interval: row.interval === "" ? null : row.interval,
          isDefault: row.isDefault,
          inventory: stock.value,
          sortOrder: index,
        });
        done += 1;

        await setGrant.mutateAsync({
          variantId: saved.id,
          kind: row.grantKind,
          config: grantConfigFor(row),
        });
        done += 1;
      }

      for (const id of removedIds) {
        await removeVariant.mutateAsync({ id });
        done += 1;
      }

      setRemovedIds([]);

      if (initial) {
        await utils.catalog.get.invalidate({ id: productId });
        await utils.catalog.syncPlan.invalidate();
        // Re-snapshot against the saved state; the overrides just became the
        // stored values, so keeping the old snapshot would show a plan for a
        // change that has already happened.
        setPlanSnapshot({ id: productId });
        setNotice("Saved.");
        router.refresh();
      } else {
        // Straight to the edit page: publishing, archiving and the Stripe plan
        // all need an id, and a create form that stays put after saving leaves
        // the admin with no way to reach them.
        router.push(`/admin/products/${productId}`);
      }
    } catch (error) {
      setFailure(
        `${messageOf(error)}${
          done > 0
            ? `\n\n${done} change${done === 1 ? "" : "s"} were already saved before this failed. Reload the page to see what landed.`
            : ""
        }`,
      );
    } finally {
      setBusy(null);
    }
  }

  async function handlePublish() {
    if (!initial) return;
    setFailure(null);
    setNotice(null);
    setBusy("publish");
    try {
      await publish.mutateAsync({ id: initial.id });
      await utils.catalog.get.invalidate({ id: initial.id });
      setNotice("Published. The product is now purchasable.");
      router.refresh();
    } catch (error) {
      // The server's message carries EVERY validation problem, one per line —
      // it re-ran `validateProduct` rather than trusting this form. Rendered
      // with `whitespace-pre-line` so the list stays a list.
      setFailure(messageOf(error));
    } finally {
      setBusy(null);
    }
  }

  async function handleArchive() {
    if (!initial) return;
    setFailure(null);
    setNotice(null);
    setBusy("archive");
    try {
      await archive.mutateAsync({ id: initial.id });
      await utils.catalog.get.invalidate({ id: initial.id });
      setNotice("Archived. Nothing was deleted — existing orders still render it.");
      router.refresh();
    } catch (error) {
      setFailure(messageOf(error));
    } finally {
      setBusy(null);
    }
  }

  function previewStripe() {
    if (!initial) return;
    setPlanSnapshot({
      id: initial.id,
      product: {
        name: name.trim() === "" ? undefined : name.trim(),
        description: description.trim() === "" ? null : description.trim(),
      },
      // Saved rows only. An unsaved row has no id, so Stripe has nothing
      // cached for it and the planner has nothing to compare against.
      variants: rows.flatMap((row) => {
        if (!row.id) return [];
        const money = parseMoneyInput(row.priceInput, row.currency);
        if (!money.ok) return [];
        return [
          {
            id: row.id,
            priceMinor: money.minor,
            currency: row.currency,
            interval: row.interval === "" ? null : row.interval,
          },
        ];
      }),
    });
  }

  const unsavedRows = rows.filter((row) => row.id === null).length;

  return (
    <div className="space-y-6">
      {failure ? (
        <p className="whitespace-pre-line rounded-[--radius-card] border border-danger bg-surface p-3 text-sm text-danger">
          {failure}
        </p>
      ) : null}
      {notice ? (
        <p className="rounded-[--radius-card] border border-line bg-accent-soft p-3 text-sm text-accent">
          {notice}
        </p>
      ) : null}

      {/* ---- product fields ------------------------------------------- */}
      <section className="rounded-[--radius-card] border border-line bg-surface p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className={LABEL} htmlFor="product-name">
              Name
            </label>
            <input
              id="product-name"
              className={FIELD}
              value={name}
              placeholder="Standard deck of cards"
              onChange={(event) => {
                setName(event.target.value);
                if (!slugTouched.current) setSlug(slugify(event.target.value));
              }}
            />
          </div>

          <div>
            <label className={LABEL} htmlFor="product-slug">
              URL slug
            </label>
            <input
              id="product-slug"
              className={FIELD}
              value={slug}
              placeholder="standard-deck"
              onChange={(event) => {
                slugTouched.current = true;
                setSlug(event.target.value);
              }}
            />
            <Problems messages={problemsByPath.get("product.slug")} />
          </div>

          <div className="sm:col-span-2">
            <label className={LABEL} htmlFor="product-description">
              Description
            </label>
            <textarea
              id="product-description"
              className={`${FIELD} min-h-20`}
              value={description}
              placeholder="What the customer is actually buying."
              onChange={(event) => setDescription(event.target.value)}
            />
            <p className="mt-1 text-xs text-ink-muted">
              Copied to the Stripe product, so it shows on the receipt.
            </p>
          </div>

          <div>
            <label className={LABEL} htmlFor="product-kind">
              Kind
            </label>
            <select
              id="product-kind"
              className={FIELD}
              value={kind}
              onChange={(event) => setKind(event.target.value as ProductKind)}
            >
              <option value="one_time">Bought once</option>
              <option value="subscription">Billed on a schedule</option>
            </select>
            <p className="mt-1 text-xs text-ink-muted">
              This decides which half of the platform sells it: a one-time
              product becomes an order line, a subscription becomes a
              subscription. Every variant&rsquo;s interval has to agree.
            </p>
          </div>

          <div>
            <span className={LABEL}>Status</span>
            <StatusBadge status={status} />
            <p className="mt-1 text-xs text-ink-muted">
              A draft sells nothing. Status only changes through Publish and
              Archive, so every change to it is permission-checked and written
              to the audit log.
            </p>
          </div>
        </div>
      </section>

      {/* ---- variants -------------------------------------------------- */}
      <VariantEditor
        rows={rows}
        kind={kind}
        disabled={!canEditPrices}
        problemsByPath={problemsByPath}
        onChange={patchRow}
        onAdd={addRow}
        onRemove={dropRow}
      />

      {!canEditPrices ? (
        <p className="rounded-[--radius-card] border border-line bg-surface p-3 text-sm text-ink-muted">
          You can edit this product but not its prices. Changing what a customer
          is charged is <code className="text-ink">catalog.prices.edit</code>,
          held separately from editing the copy.
        </p>
      ) : null}

      {/* ---- everything that is wrong, at once ------------------------- */}
      <ProblemSummary problems={problems} moneyProblems={moneyProblems} />

      {/* ---- what Stripe will do --------------------------------------- */}
      {initial ? (
        <StripePlan
          plan={plan.data}
          loading={plan.isPending}
          error={plan.error?.message ?? null}
          unsavedRows={unsavedRows}
          onPreview={previewStripe}
        />
      ) : null}

      {/* ---- actions ---------------------------------------------------- */}
      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
        <button
          type="button"
          className={PRIMARY}
          onClick={() => void handleSave()}
          disabled={busy !== null || blocked}
        >
          {busy === "save" ? "Saving…" : initial ? "Save changes" : "Create product"}
        </button>

        {initial && canPublishProducts && status !== "active" ? (
          <button
            type="button"
            className={PRIMARY}
            onClick={() => void handlePublish()}
            disabled={busy !== null || blocked || unsavedRows > 0}
          >
            {busy === "publish" ? "Publishing…" : "Publish"}
          </button>
        ) : null}

        {initial && canArchiveProducts && status !== "archived" ? (
          <button
            type="button"
            className={`${SECONDARY} text-danger`}
            onClick={() => void handleArchive()}
            disabled={busy !== null}
          >
            {busy === "archive" ? "Archiving…" : "Archive"}
          </button>
        ) : null}

        {blocked ? (
          <span className="text-sm text-ink-muted">
            Fix the problems above first — the server checks the same rules and
            will refuse.
          </span>
        ) : null}
        {!blocked && unsavedRows > 0 && initial ? (
          <span className="text-sm text-ink-muted">
            Save before publishing: {unsavedRows} variant
            {unsavedRows === 1 ? " has" : "s have"} not been written yet.
          </span>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { readonly status: ProductStatus }) {
  const tone =
    status === "active"
      ? "border-accent bg-accent-soft text-accent"
      : status === "archived"
        ? "border-danger bg-surface text-danger"
        : "border-line bg-canvas text-ink-muted";
  return (
    <span
      className={`inline-block rounded-[--radius-card] border px-2 py-0.5 text-xs font-medium ${tone}`}
    >
      {status}
    </span>
  );
}

/**
 * Every problem, in one list, always.
 *
 * `validateProduct` returns a list rather than throwing on the first rule for
 * exactly this: an admin who fixes the slug, saves, is told about the missing
 * interval, fixes that, saves, is told about the second default variant, is an
 * admin who abandons the product half configured on the fourth round trip.
 */
function ProblemSummary({
  problems,
  moneyProblems,
}: {
  readonly problems: readonly Problem[];
  readonly moneyProblems: readonly string[];
}) {
  if (problems.length === 0 && moneyProblems.length === 0) return null;
  return (
    <section className="rounded-[--radius-card] border border-danger bg-surface p-4">
      <h2 className="text-sm font-semibold text-danger">
        {problems.length + moneyProblems.length} thing
        {problems.length + moneyProblems.length === 1 ? "" : "s"} to fix before
        this can be published
      </h2>
      <ul className="mt-2 space-y-1.5">
        {moneyProblems.map((message) => (
          <li key={message} className="text-sm text-ink">
            {message}
          </li>
        ))}
        {problems.map((problem) => (
          <li key={`${problem.code}:${problem.path}`} className="text-sm text-ink">
            {problem.message}
            <span className="ml-1 text-xs text-ink-muted">({problem.path})</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * What pressing Save or Publish will do inside Stripe, in words, first.
 *
 * *** STRIPE PRICES ARE IMMUTABLE, AND THAT SURPRISES PEOPLE. ***
 *
 * Changing an amount does not edit the price — it creates a new one and
 * archives the old, and every existing subscription stays on the old price
 * until it is explicitly migrated. Teams discover this at renewal, when half
 * their subscribers turn out to be on an orphaned price. Saying it out loud
 * before the button is pressed is the difference between trust and a support
 * ticket, and it costs one paragraph.
 */
function StripePlan({
  plan,
  loading,
  error,
  unsavedRows,
  onPreview,
}: {
  readonly plan:
    | {
        readonly variants: readonly {
          readonly variantId: string;
          readonly variantName: string;
          readonly plan: SyncPlan | null;
          readonly error: string | null;
        }[];
        readonly isNoop: boolean;
      }
    | undefined;
  readonly loading: boolean;
  readonly error: string | null;
  readonly unsavedRows: number;
  readonly onPreview: () => void;
}) {
  return (
    <section className="rounded-[--radius-card] border border-line bg-surface p-4">
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-ink">What happens in Stripe</h2>
          <p className="text-sm text-ink-muted">
            A preview. Nothing here has been sent to Stripe.
          </p>
        </div>
        <button type="button" className={SECONDARY} onClick={onPreview}>
          Check my unsaved changes
        </button>
      </div>

      <div className="mt-3 space-y-3">
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        {loading ? <p className="text-sm text-ink-muted">Working it out…</p> : null}

        {plan && plan.variants.length === 0 ? (
          <p className="text-sm text-ink-muted">
            No saved variants yet, so there is no price for Stripe to hold. Add
            a variant and save.
          </p>
        ) : null}

        {plan?.variants.map((entry) => (
          <div key={entry.variantId}>
            <p className="text-[11px] font-medium uppercase tracking-wider text-ink-muted">
              {entry.variantName}
            </p>
            {entry.error ? (
              <p className="text-sm text-danger">{entry.error}</p>
            ) : (
              <ul className="mt-1 space-y-1.5">
                {entry.plan?.steps.map((step, index) => (
                  <li key={`${step.action}-${index}`} className="text-sm text-ink">
                    <span
                      className={
                        step.action === "archive-price-and-create"
                          ? "font-medium text-warn"
                          : "font-medium"
                      }
                    >
                      {STEP_LABEL[step.action] ?? step.action}
                    </span>
                    <span className="block text-xs text-ink-muted">{step.reason}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}

        {unsavedRows > 0 ? (
          <p className="text-xs text-ink-muted">
            {unsavedRows} unsaved variant{unsavedRows === 1 ? " is" : "s are"} not
            in this plan. Stripe has nothing cached for a row that has never been
            written, so there is nothing to compare against yet.
          </p>
        ) : null}
      </div>
    </section>
  );
}

function Problems({ messages }: { readonly messages?: readonly string[] }) {
  if (!messages || messages.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5">
      {messages.map((message) => (
        <li key={message} className="text-xs text-danger">
          {message}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Run the package's validator over the form as it stands.
 *
 * `status: "active"` rather than the product's real status, because the
 * question the builder is answering is "what stops this from going live". With
 * the stored `'draft'` the rule that matters most — an active product needs a
 * variant — never fires, and the admin finds out at the publish button.
 *
 * Money problems are kept separate: an unparseable price is not something
 * `validateProduct` can see, because by the time it runs the value is already a
 * bigint. Reported together, so the summary really is everything at once.
 */
function validateEverything(input: {
  readonly slug: string;
  readonly name: string;
  readonly kind: ProductKind;
  readonly rows: readonly VariantRow[];
}): {
  problems: readonly Problem[];
  problemsByPath: ReadonlyMap<string, readonly string[]>;
  moneyProblems: readonly string[];
  publishable: boolean;
} {
  const moneyProblems: string[] = [];

  const variants: VariantDraft[] = input.rows.map((row, index) => {
    const label = row.name.trim() === "" ? `variant ${index + 1}` : row.name.trim();
    const money = parseMoneyInput(row.priceInput, row.currency);
    if (!money.ok) moneyProblems.push(`"${label}": ${money.message}`);

    const stock = parseInventoryInput(row.inventoryInput);
    if (!stock.ok) moneyProblems.push(`"${label}": ${stock.message}`);

    return {
      id: row.id ?? undefined,
      sku: row.sku.trim() === "" ? null : row.sku.trim(),
      name: row.name.trim(),
      // 0 is a stand-in for an amount that could not be parsed; the failure is
      // already reported above, and substituting it keeps every OTHER rule
      // running instead of hiding them behind one bad field.
      priceMinor: money.ok ? money.minor : 0n,
      currency: row.currency,
      interval: row.interval === "" ? null : row.interval,
      isDefault: row.isDefault,
      inventory: stock.ok ? stock.value : null,
    };
  });

  // One grant per row, in row order, so `grants[i]` in a problem path is the
  // same i the variant editor renders.
  const grants: GrantDraft[] = input.rows.map((row) => ({
    variantId: row.id ?? undefined,
    kind: row.grantKind,
    config: grantConfigFor(row),
  }));

  const problems = validateProduct({
    product: {
      slug: input.slug.trim(),
      kind: input.kind,
      status: "active",
      name: input.name.trim(),
    },
    variants,
    grants,
  });

  const problemsByPath = new Map<string, string[]>();
  for (const problem of problems) {
    const bucket = problemsByPath.get(problem.path);
    if (bucket) bucket.push(problem.message);
    else problemsByPath.set(problem.path, [problem.message]);
  }

  return {
    problems,
    problemsByPath,
    moneyProblems,
    // The package's own rule, aliased on import only so it does not read like
    // the `canPublishProducts` permission prop.
    publishable: catalogCanPublish(problems),
  };
}

function rowFromInitial(variant: ProductFormInitialVariant): VariantRow {
  const config = variant.grant?.config ?? {};
  return {
    key: variant.id,
    id: variant.id,
    name: variant.name,
    sku: variant.sku ?? "",
    priceInput: variant.priceInput,
    currency: variant.currency,
    interval: variant.interval ?? "",
    isDefault: variant.isDefault,
    inventoryInput: variant.inventory === null ? "" : String(variant.inventory),
    grantKind: variant.grant?.kind ?? "none",
    grantFeature: readText(config, "feature"),
    grantLimit: readText(config, "limit"),
    grantSeats: readText(config, "seats"),
    grantKeyFormat: readText(config, "keyFormat"),
    grantWeightGrams: readText(config, "weightGrams"),
    grantRequiresAddress: config["requiresAddress"] === true,
  };
}

/**
 * Read one jsonb field back into a text input.
 *
 * `config` is deliberately open — a row written under last year's shape must
 * still load — so anything that is not a string or a finite number is treated
 * as absent rather than rendered as "[object Object]" into a field the admin
 * would then save back.
 */
function readText(config: Readonly<Record<string, unknown>>, key: string): string {
  const value = config[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/** Lowercase alphanumerics in hyphen-separated groups, matching SLUG_PATTERN. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96)
    .replace(/-+$/g, "");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
