"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type GrantKind,
  type Problem,
  type ProductKind,
  type ProductStatus,
  type SyncPlan,
  type VariantInterval,
} from "__SCOPE__/catalog";
import { parseMoneyInput } from "@/components/admin/money";
import { reviewProductDraft } from "@/components/admin/productDraft";
import {
  describeSaveFailure,
  formFieldId,
  type FieldFault,
} from "@/components/admin/saveErrors";
import {
  saveProduct,
  type ProductWriteGateway,
  type SaveJournal,
} from "@/components/admin/saveProduct";
import { emptyVariantRow, type VariantRow } from "@/components/admin/variantRow";
import { VariantEditor } from "@/components/admin/VariantEditor";
import { api } from "@/trpc/client";

/**
 * The product builder, for both /admin/products/new and /admin/products/[id].
 *
 * One component for both, because a create form and an edit form that diverge
 * end up with different validation, and the one that gets less use is the one
 * that ships a broken product. The only difference is that a product with no id
 * yet cannot publish, archive, or plan a Stripe sync.
 *
 * COPIED SOURCE. Restyle it freely. What must NOT move in here is the
 * decision-making: `validateProduct` is the package's, run again on the server
 * in `catalog.publish`, and the sync plan comes back from `catalog.syncPlan`
 * already worked out. A browser holding its own copy of the rules is how a UI
 * ends up offering a button the API then refuses.
 *
 * NEITHER DOES THE SAVE CHAIN LIVE HERE. It is `saveProduct` in
 * ./saveProduct.ts, driven through an interface, because the defect that made
 * this form unusable — a variant that was written to the database while the
 * form went on insisting it was unsaved, with Publish disabled forever — was
 * invisible in isolation and obvious the moment the sequence could be run by a
 * test. `jsx: "preserve"` means a `.tsx` cannot be imported by vitest at all,
 * so a rule that lives in a component file is a rule nothing checks.
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

/** How much text the write procedures accept. Matched on the inputs below. */
const DESCRIPTION_MAX_LENGTH = 5_000;

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
  /**
   * The product's id, held in state rather than read off `initial`.
   *
   * On the edit page it never changes. On the CREATE page it is null until
   * `catalog.create` returns, and then it is not null any more — which is the
   * difference between "press Save again" and "you now have two products, and
   * the second save is refused for a duplicate slug". A create that fails after
   * the product row lands is an ordinary outcome of a dropped connection, and
   * the form has to be able to carry on from it.
   */
  const [productId, setProductId] = useState<string | null>(initial?.id ?? null);
  const [removedIds, setRemovedIds] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState<null | "save" | "publish" | "archive">(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * Fields the SERVER refused, rendered through the same component as the
   * validator's own problems so a refusal from either source appears under the
   * input it is about rather than as a paragraph at the top of the page.
   */
  const [serverFaults, setServerFaults] = useState<readonly FieldFault[]>([]);
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
  const review = useMemo(
    () => reviewProductDraft({ slug, name, kind, rows }),
    [slug, name, kind, rows],
  );

  /**
   * The validator's problems and the server's refusals, in one map.
   *
   * Both are keyed the same way — `product.name`, `variants[1].name`,
   * `grants[0].config.feature` — precisely so the field components below need
   * to know nothing about where a message came from.
   */
  const problemsByPath = useMemo(
    () => withServerFaults(review.problemsByPath, serverFaults),
    [review.problemsByPath, serverFaults],
  );

  // `review.writable` is the PACKAGE's rule, not `problems.length === 0`
  // written out again here. Two copies of it drift the moment someone decides
  // one problem is "only a warning", and the first warning anybody adds is
  // always the one that ships a broken price.
  const blocked = !review.writable;
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

  /**
   * Put the cursor on the field a message names.
   *
   * A sentence naming a field on a form with eight variant rows still leaves
   * the reader scrolling. The ids come from `formFieldId`, which is the one
   * place that knows a variant's inputs are keyed on the row's `key`.
   */
  function revealField(path: string | null) {
    if (path === null) return;
    const elementId = formFieldId(path, rows.map((row) => row.key));
    if (elementId === null) return;
    const element = document.getElementById(elementId);
    if (element === null) return;
    element.focus({ preventScroll: true });
    element.scrollIntoView({ block: "center" });
  }

  /**
   * The four procedures, behind the interface `saveProduct` writes through.
   *
   * Wrapped rather than passed directly so the chain depends on a shape it
   * declares, and a test can supply four functions instead of a tRPC client.
   */
  const gateway: ProductWriteGateway = {
    createProduct: (input) => create.mutateAsync(input),
    updateProduct: (input) => update.mutateAsync(input),
    upsertVariant: (input) => upsertVariant.mutateAsync(input),
    setGrant: (input) => setGrant.mutateAsync(input),
    removeVariant: (input) => removeVariant.mutateAsync(input),
  };

  /**
   * Every id the server hands back, adopted the instant it arrives.
   *
   * THE FIX FOR THE BLOCKER, and the reason it is a callback rather than a
   * return value: a chain that fails at step five must leave the form knowing
   * about steps one to four. A save that recorded nothing until it finished
   * would be a save that recorded nothing at all on the one occasion it
   * mattered.
   */
  const journal: SaveJournal = {
    productWritten: (id) => setProductId(id),
    variantWritten: (rowKey, variantId) =>
      setRows((current) =>
        current.map((row) => (row.key === rowKey ? { ...row, id: variantId } : row)),
      ),
    variantRemoved: (variantId) =>
      setRemovedIds((current) => current.filter((candidate) => candidate !== variantId)),
  };

  async function handleSave() {
    setFailure(null);
    setNotice(null);
    setServerFaults([]);
    setBusy("save");

    try {
      const outcome = await saveProduct(
        { productId, slug, name, description, kind, rows, removedIds },
        gateway,
        journal,
      );

      if (outcome.status === "refused") {
        // Nothing was sent. The list is already on screen under the fields; the
        // line here says why the button did nothing, and the cursor moves to
        // the first thing to fix.
        setFailure(
          `Nothing was saved. ${outcome.reasons.length} thing` +
            `${outcome.reasons.length === 1 ? "" : "s"} on this form cannot be ` +
            `written as ${outcome.reasons.length === 1 ? "it stands" : "they stand"}:` +
            `\n\n${outcome.reasons.map((reason) => `• ${reason}`).join("\n")}`,
        );
        revealField(outcome.faultPath);
        return;
      }

      if (outcome.status === "failed") {
        const report = describeSaveFailure(outcome.error, outcome.step);
        setServerFaults(report.faults);
        setFailure(`${report.message}${landedNote(outcome.written, initial !== undefined)}`);
        revealField(report.faults[0]?.path ?? null);
        return;
      }

      if (initial) {
        await utils.catalog.get.invalidate({ id: outcome.productId });
        await utils.catalog.syncPlan.invalidate();
        // Re-snapshot against the saved state; the overrides just became the
        // stored values, so keeping the old snapshot would show a plan for a
        // change that has already happened.
        setPlanSnapshot({ id: outcome.productId });
        setNotice("Saved. Every variant on this form is now a row in the database.");
        router.refresh();
      } else {
        // Straight to the edit page: publishing, archiving and the Stripe plan
        // all need an id, and a create form that stays put after saving leaves
        // the admin with no way to reach them.
        router.push(`/admin/products/${outcome.productId}`);
      }
    } catch (error) {
      // `saveProduct` returns its failures rather than throwing, so anything
      // arriving here came from the refetch or the navigation AFTER the writes
      // succeeded. Say so, rather than implying the save did not happen.
      setFailure(
        `The product was saved. Refreshing the page afterwards failed: ` +
          `${describeSaveFailure(error, { kind: "product" }).message}`,
      );
    } finally {
      setBusy(null);
    }
  }

  async function handlePublish() {
    if (productId === null) return;
    setFailure(null);
    setNotice(null);
    setServerFaults([]);
    setBusy("publish");
    try {
      await publish.mutateAsync({ id: productId });
      await utils.catalog.get.invalidate({ id: productId });
      setNotice("Published. The product is now purchasable.");
      router.refresh();
    } catch (error) {
      // The server's message carries EVERY validation problem, one per line —
      // it re-ran `validateProduct` rather than trusting this form. Rendered
      // with `whitespace-pre-line` so the list stays a list.
      setFailure(describeSaveFailure(error, { kind: "product" }).message);
    } finally {
      setBusy(null);
    }
  }

  async function handleArchive() {
    if (productId === null) return;
    setFailure(null);
    setNotice(null);
    setServerFaults([]);
    setBusy("archive");
    try {
      await archive.mutateAsync({ id: productId });
      await utils.catalog.get.invalidate({ id: productId });
      setNotice("Archived. Nothing was deleted — existing orders still render it.");
      router.refresh();
    } catch (error) {
      setFailure(describeSaveFailure(error, { kind: "product" }).message);
    } finally {
      setBusy(null);
    }
  }

  function previewStripe() {
    if (productId === null) return;
    setPlanSnapshot({
      id: productId,
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
        <div className="rounded-[--radius-card] border border-danger bg-surface p-3">
          <p className="whitespace-pre-line text-sm text-danger">{failure}</p>
          {/* A product created by a chain that then failed. On the EDIT page
              reloading is at least possible; on the create page there was
              nothing to reload, which is why "reload the page" was never a
              recovery story here. It exists now, and so does the product. */}
          {initial === undefined && productId !== null ? (
            <p className="mt-2 text-sm text-ink-muted">
              The product exists as a draft. Fix the above and press{" "}
              <span className="text-ink">Create product</span> again — this form
              holds its id, so it updates that product rather than creating a
              second one — or{" "}
              <Link
                href={`/admin/products/${productId}`}
                className={`text-accent underline underline-offset-2 ${FOCUS} rounded-[--radius-card]`}
              >
                open it on its own page
              </Link>
              .
            </p>
          ) : null}
        </div>
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
              aria-invalid={problemsByPath.has("product.name")}
              onChange={(event) => {
                setName(event.target.value);
                if (!slugTouched.current) setSlug(slugify(event.target.value));
              }}
            />
            <Problems messages={problemsByPath.get("product.name")} />
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
              aria-invalid={problemsByPath.has("product.slug")}
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
              maxLength={DESCRIPTION_MAX_LENGTH}
              placeholder="What the customer is actually buying."
              onChange={(event) => setDescription(event.target.value)}
            />
            <p className="mt-1 text-xs text-ink-muted">
              Copied to the Stripe product, so it shows on the receipt.
            </p>
            <Problems messages={problemsByPath.get("product.description")} />
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
      <ProblemSummary problems={review.problems} moneyProblems={review.moneyProblems} />

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

/** The validator's problems plus whatever the server refused, one map. */
function withServerFaults(
  problemsByPath: ReadonlyMap<string, readonly string[]>,
  faults: readonly FieldFault[],
): ReadonlyMap<string, readonly string[]> {
  if (faults.length === 0) return problemsByPath;
  const merged = new Map<string, readonly string[]>(problemsByPath);
  for (const fault of faults) {
    merged.set(fault.path, [...(merged.get(fault.path) ?? []), fault.message]);
  }
  return merged;
}

/**
 * What had already landed when a chain broke, and what to do about it.
 *
 * The count is the honest one — every confirmed write, not every attempt — and
 * the advice is to press the button again rather than to reload, because every
 * row that landed now carries its id and will be updated rather than
 * duplicated. "1 change were already saved" was the previous wording, from a
 * ternary that pluralised the noun and left the verb alone.
 */
function landedNote(written: number, isEdit: boolean): string {
  if (written === 0) return "\n\nNothing was written: this failed on the first call.";
  const changes = `${written} change${written === 1 ? " was" : "s were"}`;
  return (
    `\n\n${changes} already written before this failed. Press ` +
    `${isEdit ? "Save changes" : "Create product"} again once it is fixed — every ` +
    `row that landed is now held by its id, so it is updated rather than written twice.`
  );
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
