import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode, type Ref } from "react";
import type { EstimatorPublicTransport } from "./client.js";
import { cleanInputs, CustomerFields, RadioChips, Stepper } from "./fields.js";
import {
  buildSubmitBody,
  EMPTY_DETAILS,
  firstInvalidField,
  LIMITS,
  mapSubmitIssues,
  validateDetails,
  type DetailsErrors,
  type DetailsField,
  type DetailsValues,
} from "./form.js";
import { firstName, formatModifier, formatRange, friendlyError, withParam } from "./format.js";
import type { ClientError } from "./http.js";
import {
  CameraIcon,
  CheckIcon,
  ContactLinks,
  CrossIcon,
  describedBy,
  Field,
  Honeypot,
  Notice,
  resolveAccent,
  Skeleton,
  useMounted,
  useStepFocus,
  WidgetRoot,
  type ChromeProps,
} from "./parts.js";
import { NOT_A_PHOTO, resizePhoto } from "./photo.js";
import { PriceCard, type PriceState } from "./price.js";
import { usePublicTransport, wait } from "./transport.js";
import type {
  CustomerInputs,
  PublicConfig,
  PublicPrice,
  PublicProduct,
  SubmitItem,
  SubmitResponse,
  TakeoffReading,
  TakeoffResponse,
} from "./types.js";

/**
 * <EstimateTool> — a customer gets a real price on the business's website, in
 * one card (contract 9.3):
 *
 *   what      which product (chips; skipped with one, or a locked one)
 *   measure   the SERVER's questions in plain words ("How many steps go up
 *             to the door?"), never a number they'd have to work out
 *   photo     optional: shown back at once; for a ramp the AI's reading
 *             ("We counted 3 steps.") pre-fills the count, marked "From your
 *             photo", in the same stepper they can change
 *   options   chips, "+$120"
 *   price     live, 300 ms after the last change: one number or a range, how
 *             it was worked out, what was assumed and why it's a range — every
 *             word the server's
 *   details   name, email or phone, address, notes
 *   done      the reference, the range, what happens next, "Book a visit"
 *
 * THE WIDGET DOES NO ARITHMETIC. It sends what the customer answered and shows
 * what the server worked out. A photo never measures anything: the server
 * returns what the model SAW, and the count goes into the stepper.
 *
 * SPAM. A honeypot field a person never sees, and the time between the form
 * appearing and the submit (`fillMs`). A customer faster than the server's
 * floor (autofill) waits it out ("Sending…") instead of meeting "spam".
 */

export interface EstimateToolProps extends ChromeProps {
  /** The mounted public handlers, e.g. "/api/estimator". Ignored when `transport` is given. */
  baseUrl?: string;
  /** The embed key, for a page on ANOTHER website. */
  clientKey?: string;
  transport?: EstimatorPublicTransport;
  /** Preselect this product. */
  productId?: string;
  /** With `productId`: don't offer the others. */
  lockProduct?: boolean;
  /** Default "Get an instant estimate". */
  title?: string;
  /** Default "A real price in a minute, before anyone drives out." */
  intro?: string;
  /** After saving: "Book a visit to measure" → bookHref + (? or &) + "estimate=" + estimateId. */
  bookHref?: string;
  /** Undefined: the business's colour from its settings; null: the stylesheet's; a `#rrggbb`: that. */
  accentColor?: string | null;
  /** Show "Powered by AdminIgloo". Default false. */
  poweredBy?: boolean;
  /** Called once per saved estimate. */
  onSubmitted?: (result: SubmitResponse) => void;
}

export const DEFAULT_TITLE = "Get an instant estimate";
export const DEFAULT_INTRO = "A real price in a minute, before anyone drives out.";

export type ConfigState = { status: "loading" } | { status: "ready"; config: PublicConfig } | { status: "error"; error: ClientError };

/** The business's settings and products, with a retry. Shared by the inline tool and the modal. */
export function useEstimatorConfig(transport: EstimatorPublicTransport): { state: ConfigState; reload: () => void } {
  const [state, setState] = useState<ConfigState>({ status: "loading" });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setState({ status: "loading" });
    void transport.config().then((res) => {
      if (!alive) return;
      setState(res.ok ? { status: "ready", config: res.data } : { status: "error", error: res.error });
    });
    return () => {
      alive = false;
    };
  }, [transport, tick]);
  return { state, reload: useCallback(() => setTick((n) => n + 1), []) };
}

export function EstimateTool(props: EstimateToolProps) {
  const transport = usePublicTransport(props.transport, props.baseUrl, props.clientKey);
  const { state, reload } = useEstimatorConfig(transport);
  const config = state.status === "ready" ? state.config : null;
  const accent = resolveAccent(props.accentColor, config?.brandColor);
  const [phase, setPhase] = useState("loading");
  return (
    <WidgetRoot
      theme={props.theme}
      nonce={props.nonce}
      className={`aiew-card${props.className ? ` ${props.className}` : ""}`}
      style={props.style}
      accent={accent}
      data={{ "aiew-tool": phase }}
    >
      <div className="aiew-body">
        <EstimateFlow {...props} transport={transport} configState={state} reload={reload} showHeader onPhase={setPhase} />
      </div>
    </WidgetRoot>
  );
}

// ---------------------------------------------------------------------------
// The flow (inline in the tool, and inside the modal)
// ---------------------------------------------------------------------------

interface PhotoItem {
  localId: string;
  /**
   * Always a `data:` URL of the shrunk JPEG (the base64 is already in hand).
   * Never a `blob:` object URL: a host with a strict Content-Security-Policy
   * allows `img-src data:` far more often than `blob:`, and under it a blob
   * preview is a silently broken image beside the AI's reading (review RL-05).
   */
  previewUrl: string;
  working: boolean;
  workingLabel: string | null;
  photoId: string | null;
  reading: TakeoffReading | null;
  notes: Array<{ tone: "info" | "ok" | "warn"; text: string }>;
}

const CONFIDENCE_LABEL: Record<TakeoffReading["confidence"], string> = { low: "Not sure", medium: "Fairly sure", high: "Sure" };
const PHOTO_BADGE = "From your photo";
const MAX_PHOTOS = 3;

/** What to say for a takeoff answer that isn't a reading, when the server sent no message. */
function takeoffFallback(status: TakeoffResponse["status"]): string {
  switch (status) {
    case "not_needed":
      return "You've measured it already, so we'll use your numbers.";
    case "not_supported":
      return "Thanks for the photo. This one is priced from your measurements, so please enter them yourself.";
    case "busy":
      return "We're already reading this photo. Give it a moment and try again.";
    default:
      return "We can't read photos right now, so please enter your numbers yourself.";
  }
}

let photoSeq = 0;

export interface EstimateFlowProps extends EstimateToolProps {
  transport: EstimatorPublicTransport;
  configState: ConfigState;
  reload: () => void;
  /** The title and intro at the top (the modal puts them in its own head). */
  showHeader: boolean;
  /** Where the flow is, for the root's `data-aiew-tool`. */
  onPhase?: (phase: string) => void;
}

export function EstimateFlow(props: EstimateFlowProps) {
  const { transport, configState } = props;
  const config = configState.status === "ready" ? configState.config : null;
  const locale = props.locale ?? config?.locale ?? "en-US";
  const ids = useId();
  const mounted = useMounted();
  const title = props.title ?? DEFAULT_TITLE;
  const intro = props.intro ?? DEFAULT_INTRO;

  // ---- which product -------------------------------------------------------
  const products = config?.products ?? [];
  const preset = props.productId ? products.find((p) => p.id === props.productId) : undefined;
  const offered: PublicProduct[] = props.lockProduct && preset ? [preset] : products;
  const [chosenId, setChosenId] = useState<string | null>(null);
  const product: PublicProduct | null =
    offered.find((p) => p.id === chosenId) ?? preset ?? (offered.length === 1 ? offered[0]! : null);

  // ---- what the customer answered (for the product on screen) -------------
  const [values, setValues] = useState<CustomerInputs>({});
  const [badges, setBadges] = useState<Record<string, string>>({});
  const [quantity, setQuantity] = useState<number | null>(1);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [takeoffId, setTakeoffId] = useState<string | null>(null);
  const [readingTried, setReadingTried] = useState<Record<string, boolean>>({});
  const [inputErrors, setInputErrors] = useState<Record<string, string>>({});
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const photosRef = useRef(photos);
  photosRef.current = photos;
  // The latest answers, for the photo flow: it awaits a resize and a reading,
  // and the customer may type meanwhile.
  const valuesRef = useRef(values);
  valuesRef.current = values;
  const badgesRef = useRef(badges);
  badgesRef.current = badges;

  // ---- the price -----------------------------------------------------------
  const [priceState, setPriceState] = useState<PriceState>({ status: "idle" });
  const [priceLoading, setPriceLoading] = useState(false);
  const [lastPrice, setLastPrice] = useState<PublicPrice | null>(null);
  const [everPriced, setEverPriced] = useState(false);
  const requestId = useRef(0);

  // ---- the details form and the result -------------------------------------
  const [details, setDetails] = useState<DetailsValues>(EMPTY_DETAILS);
  const [detailErrors, setDetailErrors] = useState<DetailsErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SubmitResponse | null>(null);
  const formShownAt = useRef<number | null>(null);
  const firedFor = useRef<string | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  const doneRef = useStepFocus<HTMLHeadingElement>(focusTick);

  // The default option values, whenever the product changes.
  const productId = product?.id ?? null;
  const resetForProduct = useCallback((next: PublicProduct | null) => {
    setValues({});
    setBadges({});
    setQuantity(1);
    setTakeoffId(null);
    setInputErrors({});
    setPriceState({ status: "idle" });
    setLastPrice(null);
    setEverPriced(false);
    const defaults: Record<string, string> = {};
    for (const option of next?.options ?? []) {
      const value = option.values.find((v) => v.isDefault) ?? option.values[0];
      if (value) defaults[option.id] = value.id;
    }
    setChoices(defaults);
  }, []);
  const lastProduct = useRef<string | null>(null);
  useEffect(() => {
    if (lastProduct.current === productId) return;
    lastProduct.current = productId;
    resetForProduct(product);
  }, [productId, product, resetForProduct]);

  const inputs = useMemo(() => (product ? cleanInputs(product.fields, values) : {}), [product, values]);

  // The reading in use, and the check it carries: a customer who LOWERS the
  // count the photo filled in is asked, under that count, whether they counted
  // the step up onto the porch (2 steps and the porch is 3 risers: the founder's
  // own porch, where the AI was right and a homeowner "corrects" it to 2 and
  // gets a ramp 7–8 ft short; review EST-R04). The value stays theirs.
  const activeReading = photos.find((p) => p.reading && p.reading.takeoffId === takeoffId)?.reading ?? null;
  const checks = useMemo(() => {
    const out: Record<string, string> = {};
    if (!activeReading || activeReading.status !== "read" || !activeReading.usable || !activeReading.fewerCheck) return out;
    for (const [key, suggested] of Object.entries(activeReading.suggested)) {
      const value = values[key];
      if (typeof suggested === "number" && typeof value === "number" && value < suggested) out[key] = activeReading.fewerCheck;
    }
    return out;
  }, [activeReading, values]);

  // "Change the count" in the reading card: to the field, focused. The count
  // sits ABOVE the photo, so no sentence may say "below" (review EST-R07).
  const measureRef = useRef<HTMLElement | null>(null);
  const focusMeasure = (key: string) => {
    const input = measureRef.current?.querySelector<HTMLInputElement>(`[data-aiew-field="${key}"] input`);
    if (!input) return;
    input.scrollIntoView?.({ block: "center", behavior: "smooth" });
    input.focus();
    input.select?.();
  };
  const optionValueIds = useMemo(
    () => (product ? product.options.map((o) => choices[o.id]).filter((v): v is string => Boolean(v)) : []),
    [product, choices],
  );
  const quantityToSend = product?.quantity ? Math.max(1, Math.min(product.quantity.max, quantity ?? 1)) : undefined;
  const priceKey = JSON.stringify([productId, inputs, quantityToSend ?? null, optionValueIds, takeoffId]);

  // ---- calculate: 300 ms after the last change, newest answer only ---------
  useEffect(() => {
    if (!product || !product.isEstimatable || result) return;
    if (product.fields.length > 0 && Object.keys(inputs).length === 0) {
      requestId.current += 1;
      setPriceLoading(false);
      setPriceState({ status: "needs_inputs" });
      return;
    }
    const id = ++requestId.current;
    setPriceLoading(true);
    const timer = setTimeout(() => {
      void transport
        .calculate({
          productId: product.id,
          inputs,
          ...(quantityToSend !== undefined ? { quantity: quantityToSend } : {}),
          optionValueIds,
          ...(takeoffId ? { takeoffId } : {}),
        })
        .then((res) => {
          // An answer to a question the customer has since changed is ignored.
          if (id !== requestId.current || !mounted.current) return;
          setPriceLoading(false);
          if (!res.ok) {
            const mapped = mapSubmitIssues(res.error.issues).inputs;
            if (Object.keys(mapped).length > 0) {
              setInputErrors(mapped);
              setPriceState({ status: "error", message: "Check the numbers above." });
            } else if (res.error.code === "estimates_closed") {
              setPriceState({ status: "error", message: friendlyError(res.error, "calculate") });
            } else {
              setPriceState({ status: "error", message: "We couldn't update the price. Check your connection." });
            }
            return;
          }
          setInputErrors({});
          const answer = res.data;
          if (answer.status === "priced" && answer.price) {
            setPriceState({ status: "priced", price: answer.price });
            setLastPrice(answer.price);
            setEverPriced(true);
          } else if (answer.status === "quote_only") {
            setPriceState({ status: "quote_only" });
          } else {
            setPriceState({ status: "needs_inputs" });
          }
        });
    }, 300);
    return () => clearTimeout(timer);
    // `priceKey` stands for everything the price depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [priceKey, transport, result]);

  // ---- editing --------------------------------------------------------------
  const onFieldsChange = (next: CustomerInputs, changed: string[]) => {
    // Only the keys this edit touched, laid over the LATEST answers: a count the
    // photo filled a moment ago is never undone by an edit to another field.
    const merged = { ...valuesRef.current };
    for (const key of changed) merged[key] = next[key] ?? null;
    valuesRef.current = merged;
    setValues(merged);
    // The badge says where a number came from; once the customer changes it, it's theirs.
    setBadges((current) => {
      if (!changed.some((key) => current[key])) return current;
      const copy = { ...current };
      for (const key of changed) delete copy[key];
      return copy;
    });
    if (changed.some((key) => inputErrors[key])) {
      setInputErrors((current) => {
        const copy = { ...current };
        for (const key of changed) delete copy[key];
        return copy;
      });
    }
  };

  const chooseProduct = (id: string) => {
    if (id === productId) return;
    setChosenId(id);
  };

  // ---- photos ---------------------------------------------------------------
  const updatePhoto = (localId: string, patch: Partial<PhotoItem> | ((item: PhotoItem) => Partial<PhotoItem>)) => {
    setPhotos((list) => list.map((item) => (item.localId === localId ? { ...item, ...(typeof patch === "function" ? patch(item) : patch) } : item)));
  };

  const keepCopy = async (localId: string, base64: string, forProduct: string | null, notes: PhotoItem["notes"]) => {
    if (!config?.photos.attach) {
      updatePhoto(localId, { working: false, workingLabel: null, notes });
      return;
    }
    updatePhoto(localId, { workingLabel: "Adding your photo…" });
    const res = await transport.photo({ imageBase64: base64, mediaType: "image/jpeg", ...(forProduct ? { productId: forProduct } : {}) });
    if (!mounted.current) return;
    if (res.ok) {
      updatePhoto(localId, {
        working: false,
        workingLabel: null,
        photoId: res.data.photoId,
        notes: [...notes, { tone: "ok", text: "Photo added. The business will see it with your estimate." }],
      });
    } else {
      updatePhoto(localId, {
        working: false,
        workingLabel: null,
        notes: [...notes, { tone: "warn", text: "We couldn't keep this photo, but you can still get your estimate." }],
      });
    }
  };

  const addPhoto = async (file: File) => {
    if (!config || photosRef.current.length >= MAX_PHOTOS) return;
    setPhotoError(null);
    let resized;
    try {
      resized = await resizePhoto(file, { maxEdgePx: config.photos.maxEdgePx, quality: config.photos.jpegQuality });
    } catch (error) {
      if (mounted.current) setPhotoError(error instanceof Error && error.message ? error.message : NOT_A_PHOTO);
      return;
    }
    if (!mounted.current) return;
    const localId = `p${++photoSeq}`;
    const read = Boolean(product && product.photo.reading && !readingTried[product.id] && !takeoffId);
    const item: PhotoItem = {
      localId,
      previewUrl: `data:image/jpeg;base64,${resized.base64}`,
      working: true,
      workingLabel: read ? "Reading your photo…" : "Adding your photo…",
      photoId: null,
      reading: null,
      notes: [],
    };
    setPhotos((list) => [...list, item]);

    if (!read || !product) {
      await keepCopy(localId, resized.base64, product?.id ?? null, []);
      return;
    }

    // Only what the customer TYPED goes with the photo: a job they've measured
    // is never read (the server answers "not_needed" without calling the AI).
    const typed: CustomerInputs = {};
    for (const [key, value] of Object.entries(cleanInputs(product.fields, valuesRef.current))) if (!badgesRef.current[key]) typed[key] = value;
    const forProduct = product.id;
    const res = await transport.takeoff({ productId: forProduct, imageBase64: resized.base64, mediaType: "image/jpeg", inputs: typed });
    if (!mounted.current) return;
    if (!res.ok) {
      await keepCopy(localId, resized.base64, forProduct, [{ tone: "info", text: "We couldn't read this photo, so please enter your numbers yourself." }]);
      return;
    }
    const answer = res.data;
    if (answer.status !== "busy") setReadingTried((tried) => ({ ...tried, [forProduct]: true }));
    if (answer.reading && (answer.status === "read" || answer.status === "unreadable")) {
      const reading = answer.reading;
      setTakeoffId(reading.takeoffId);
      if (reading.status === "read" && reading.usable) {
        // CONTRACT: 9.3 says `suggested` values "are filled into the fields".
        // Only EMPTY fields are filled: a count the customer already typed stays
        // theirs (the server still records the photo's count, and the business
        // sees the difference as a correction).
        const current = valuesRef.current;
        const next = { ...current };
        const filled: Record<string, string> = {};
        for (const [key, value] of Object.entries(reading.suggested)) {
          if (typeof value === "number" && (current[key] === null || current[key] === undefined)) {
            next[key] = value;
            filled[key] = PHOTO_BADGE;
          }
        }
        valuesRef.current = next;
        setValues(next);
        setBadges((existing) => ({ ...existing, ...filled }));
      }
      if (answer.photoId) updatePhoto(localId, { working: false, workingLabel: null, reading, photoId: answer.photoId });
      else {
        updatePhoto(localId, { reading });
        await keepCopy(localId, resized.base64, forProduct, []);
      }
      return;
    }
    const note = { tone: "info" as const, text: answer.message ?? takeoffFallback(answer.status) };
    if (answer.photoId) updatePhoto(localId, { working: false, workingLabel: null, photoId: answer.photoId, notes: [note] });
    else await keepCopy(localId, resized.base64, forProduct, [note]);
  };

  const removePhoto = (localId: string) => {
    const item = photosRef.current.find((p) => p.localId === localId);
    if (!item) return;
    setPhotos((list) => list.filter((p) => p.localId !== localId));
    if (item.reading && item.reading.takeoffId === takeoffId) {
      // CONTRACT: 9.3 says removing the read photo drops `takeoffId` and the
      // badges, "keeping the typed values". The numbers the photo filled stay
      // too (the customer saw them and may have agreed with them); what goes is
      // where they came from, and the photo's step-height range with it.
      setTakeoffId(null);
      setBadges({});
      if (productId) setReadingTried((tried) => ({ ...tried, [productId]: false }));
    }
  };

  // ---- submit ---------------------------------------------------------------
  // CONTRACT: 9.3 lists "Your details" after the price. It appears once there
  // IS a price (or at once for a price-by-quote product): a lead always
  // carries a priced line, and a half-measured form can't be sent.
  const showDetails = Boolean(product && (!product.isEstimatable || everPriced));
  useEffect(() => {
    if (showDetails && formShownAt.current === null) formShownAt.current = Date.now();
  }, [showDetails]);

  const updateDetail = (field: keyof DetailsValues, value: string) => {
    setDetails((current) => ({ ...current, [field]: value }));
    if (field !== "website" && detailErrors[field as DetailsField]) {
      setDetailErrors((current) => {
        const next = { ...current };
        delete next[field as DetailsField];
        return next;
      });
    }
  };

  const fieldId = (field: DetailsField | "website") => `${ids}-${field}`;
  const focusField = (field: DetailsField | null) => {
    if (field && typeof document !== "undefined") document.getElementById(fieldId(field))?.focus();
  };

  const submit = async (event: FormEvent | null, retry = false) => {
    event?.preventDefault();
    if (!config || !product || (submitting && !retry)) return;
    const errors = validateDetails(details);
    setDetailErrors(errors);
    if (Object.keys(errors).length > 0) {
      setSubmitError(null);
      focusField(firstInvalidField(errors));
      return;
    }
    if (product.isEstimatable && priceState.status !== "priced") {
      setSubmitError("Answer the questions above to see your price first.");
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    const shownAt = formShownAt.current ?? Date.now();
    const floor = config.minFillMs;
    const elapsed = Date.now() - shownAt;
    if (!retry && floor > 0 && elapsed < floor) await wait(floor - elapsed);
    const item: SubmitItem = product.isEstimatable
      ? {
          productId: product.id,
          inputs,
          ...(quantityToSend !== undefined ? { quantity: quantityToSend } : {}),
          optionValueIds,
          ...(takeoffId && !retry ? { takeoffId } : {}),
        }
      : { productId: product.id, ...(optionValueIds.length > 0 ? { optionValueIds } : {}) };
    const photoIds = retry ? [] : photos.map((p) => p.photoId).filter((id): id is string => Boolean(id));
    const res = await transport.submit(buildSubmitBody({ values: details, item, photoIds, fillMs: Date.now() - shownAt }));
    if (!mounted.current) return;
    if (res.ok) {
      setSubmitting(false);
      setResult(res.data);
      setFocusTick((n) => n + 1);
      if (firedFor.current !== res.data.estimateId) {
        firedFor.current = res.data.estimateId;
        props.onSubmitted?.(res.data);
      }
      return;
    }
    const error = res.error;
    if ((error.code === "takeoff_unavailable" || error.code === "photo_unavailable") && !retry) {
      // The photo or its reading went away (a day old, say): the estimate
      // itself is still good, so it goes once more without them.
      await submit(null, true);
      return;
    }
    setSubmitting(false);
    if (error.code === "invalid") {
      const mapped = mapSubmitIssues(error.issues);
      setDetailErrors(mapped.details);
      if (Object.keys(mapped.inputs).length > 0) setInputErrors(mapped.inputs);
      setSubmitError(friendlyError(error, "submit"));
      focusField(firstInvalidField(mapped.details));
      return;
    }
    setSubmitError(friendlyError(error, "submit"));
  };

  const startOver = () => {
    setPhotos([]);
    setPhotoError(null);
    setResult(null);
    setDetails(EMPTY_DETAILS);
    setDetailErrors({});
    setSubmitError(null);
    setReadingTried({});
    formShownAt.current = null;
    resetForProduct(product);
    setFocusTick((n) => n + 1);
  };

  // ---- the phase, for the root's data attribute ------------------------------
  let phase: string;
  if (configState.status === "loading") phase = "loading";
  else if (configState.status === "error") {
    phase = configState.error.code === "unauthorized" || configState.error.code === "origin_not_allowed" ? "not-set-up" : "error";
  } else if (!config || !config.instantEstimatesEnabled || products.length === 0) phase = "closed";
  else if (result) phase = "done";
  else phase = "ready";
  const { onPhase } = props;
  useEffect(() => {
    onPhase?.(phase);
  }, [phase, onPhase]);

  // ---- render ---------------------------------------------------------------
  const header = props.showHeader ? (
    <header className="aiew-head">
      {config?.logoUrl ? (
        // The business's logo beside its name (Tenancy 2a). alt="": the name is right there.
        <p className="aiew-brandline" data-aiew-brand="">
          <img className="aiew-logo" src={config.logoUrl} alt="" />
          <span>{config.businessName}</span>
        </p>
      ) : null}
      <h2 className="aiew-title" ref={result ? undefined : (doneRef as Ref<HTMLHeadingElement>)} tabIndex={-1}>
        {title}
      </h2>
      {intro ? <p className="aiew-sub">{intro}</p> : null}
    </header>
  ) : null;

  if (configState.status === "loading") return <Skeleton label="Loading the estimator…" />;

  if (configState.status === "error") {
    if (configState.error.code === "estimates_closed" && configState.error.message && configState.error.message !== "estimates_closed") {
      // Closed BY THE BUSINESS (Tenancy 2a, D7): its own sentence ("Green
      // Acres isn't taking requests online right now. Call …"), no retry.
      return (
        <section className="aiew-empty" data-aiew-state="closed">
          <p className="aiew-empty-title">{configState.error.message}</p>
        </section>
      );
    }
    if (phase === "not-set-up") {
      return (
        <section className="aiew-empty" data-aiew-state="not-set-up">
          <p className="aiew-empty-title">This estimator isn&apos;t set up for this website yet.</p>
          <details>
            <summary>For the site owner</summary>
            <p className="aiew-desc">Check the embed key and its allowed websites in your estimator settings.</p>
          </details>
        </section>
      );
    }
    return (
      <Notice tone="error" data="config-error">
        We couldn&apos;t load the estimator.{" "}
        <button type="button" className="aiew-btn aiew-btn-link" onClick={props.reload}>
          Retry
        </button>
      </Notice>
    );
  }

  if (!config || phase === "closed") {
    return (
      <section className="aiew-empty" data-aiew-state="closed">
        <p className="aiew-empty-title">Instant estimates aren&apos;t available right now.</p>
        {config && (config.contactPhone || config.contactEmail) ? (
          <p>
            For a price, <ContactLinks phone={config.contactPhone} email={config.contactEmail} lowercase />
          </p>
        ) : null}
      </section>
    );
  }

  if (result) {
    return (
      <Done
        result={result}
        config={config}
        locale={locale}
        price={lastPrice}
        name={details.name}
        photoCount={photos.filter((p) => p.photoId).length}
        bookHref={props.bookHref}
        headingRef={doneRef}
        onStartOver={startOver}
        poweredBy={props.poweredBy}
      />
    );
  }

  const showPhotos = Boolean(product && (config.photos.attach || product.photo.reading));
  const canAddPhoto =
    showPhotos && photos.length < MAX_PHOTOS && Boolean(config.photos.attach || (product && product.photo.reading && !readingTried[product.id] && !takeoffId));
  const priceShownState: PriceState = priceState.status === "idle" ? { status: "needs_inputs" } : priceState;

  return (
    <>
      {header}

      {offered.length > 1 ? (
        <section className="aiew-section" aria-labelledby={`${ids}-what`}>
          <h3 className="aiew-h3" id={`${ids}-what`}>
            What do you need?
          </h3>
          <RadioChips
            labelledBy={`${ids}-what`}
            choices={offered.map((p) => ({ value: p.id, label: p.name }))}
            value={product?.id ?? null}
            onChange={chooseProduct}
            data="products"
          />
          {product?.description ? <p className="aiew-desc">{product.description}</p> : null}
        </section>
      ) : product?.description ? (
        <p className="aiew-desc" data-aiew-product={product.id}>
          <strong>{product.name}.</strong> {product.description}
        </p>
      ) : null}

      {product && !product.isEstimatable ? (
        <Notice tone="info" data="quote-only">
          This one needs a quick look to price. Leave your details and we&apos;ll be in touch.
        </Notice>
      ) : null}

      {product && product.isEstimatable && product.fields.length > 0 ? (
        <section className="aiew-section" aria-labelledby={`${ids}-measure`} data-aiew-measure="" ref={measureRef}>
          <h3 className="aiew-h3" id={`${ids}-measure`}>
            About the job
          </h3>
          <CustomerFields fields={product.fields} values={values} onChange={onFieldsChange} errors={inputErrors} readOnlyBadges={badges} checks={checks} />
          {product.quantity ? (
            <div className="aiew-field" data-aiew-field="quantity">
              <label className="aiew-label" htmlFor={`${ids}-qty`}>
                {product.quantity.label}
              </label>
              <Stepper id={`${ids}-qty`} label={product.quantity.label} value={quantity} min={1} max={product.quantity.max} onValue={setQuantity} />
            </div>
          ) : null}
        </section>
      ) : null}

      {showPhotos && product ? (
        <PhotoSection
          ids={ids}
          tip={product.photo.tip}
          reads={product.photo.reading}
          photos={photos}
          canAdd={canAddPhoto}
          error={photoError}
          onAdd={(file) => void addPhoto(file)}
          onRemove={removePhoto}
          onChangeCount={focusMeasure}
        />
      ) : null}

      {product && product.isEstimatable && product.options.length > 0 ? (
        <section className="aiew-section" aria-label="Options" data-aiew-options="">
          {product.options.map((option) => (
            <div key={option.id} className="aiew-stack-sm">
              <span className="aiew-group-label" id={`${ids}-opt-${option.id}`}>
                {option.name}
              </span>
              <RadioChips
                labelledBy={`${ids}-opt-${option.id}`}
                choices={option.values.map((v) => ({
                  value: v.id,
                  label: v.label,
                  ...(v.priceModifier !== 0 ? { extra: formatModifier(v.priceModifier, config.currency, locale) } : {}),
                }))}
                value={choices[option.id] ?? null}
                onChange={(valueId) => setChoices((current) => ({ ...current, [option.id]: valueId }))}
              />
            </div>
          ))}
        </section>
      ) : null}

      {product && product.isEstimatable ? (
        <PriceCard state={priceShownState} previous={lastPrice} loading={priceLoading} locale={locale} />
      ) : null}

      {showDetails ? (
        <section className="aiew-section" aria-labelledby={`${ids}-details`} data-aiew-details="">
          <h3 className="aiew-h3" id={`${ids}-details`}>
            Your details
          </h3>
          <form className="aiew-form" noValidate onSubmit={(event) => void submit(event)} data-aiew-form="">
            <Field id={fieldId("name")} label="Your name" error={detailErrors.name}>
              <input
                id={fieldId("name")}
                name="name"
                className="aiew-input"
                type="text"
                autoComplete="name"
                maxLength={LIMITS.name}
                required
                value={details.name}
                aria-invalid={detailErrors.name ? true : undefined}
                aria-describedby={describedBy(fieldId("name"), false, detailErrors.name)}
                onChange={(event) => updateDetail("name", event.target.value)}
              />
            </Field>
            <p className="aiew-hint" id={`${ids}-reach`}>
              An email or a phone number so we can reach you.
            </p>
            <div className="aiew-row2">
              <Field id={fieldId("email")} label="Email" error={detailErrors.email}>
                <input
                  id={fieldId("email")}
                  name="email"
                  className="aiew-input"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  maxLength={LIMITS.email}
                  value={details.email}
                  aria-invalid={detailErrors.email ? true : undefined}
                  aria-describedby={[`${ids}-reach`, detailErrors.email ? `${fieldId("email")}-error` : null].filter(Boolean).join(" ")}
                  onChange={(event) => updateDetail("email", event.target.value)}
                />
              </Field>
              <Field id={fieldId("phone")} label="Phone" error={detailErrors.phone}>
                <input
                  id={fieldId("phone")}
                  name="phone"
                  className="aiew-input"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  maxLength={LIMITS.phone}
                  value={details.phone}
                  aria-invalid={detailErrors.phone ? true : undefined}
                  aria-describedby={[`${ids}-reach`, detailErrors.phone ? `${fieldId("phone")}-error` : null].filter(Boolean).join(" ")}
                  onChange={(event) => updateDetail("phone", event.target.value)}
                />
              </Field>
            </div>
            <Field id={fieldId("address")} label="Address of the job" optional hint="Street, city and ZIP code." error={detailErrors.address}>
              <input
                id={fieldId("address")}
                name="address"
                className="aiew-input"
                type="text"
                autoComplete="street-address"
                maxLength={LIMITS.address}
                value={details.address}
                aria-invalid={detailErrors.address ? true : undefined}
                aria-describedby={describedBy(fieldId("address"), true, detailErrors.address)}
                onChange={(event) => updateDetail("address", event.target.value)}
              />
            </Field>
            <Field id={fieldId("notes")} label="Anything else we should know?" optional hint="Access, timing, anything unusual." error={detailErrors.notes}>
              <textarea
                id={fieldId("notes")}
                name="notes"
                className="aiew-input"
                rows={3}
                maxLength={LIMITS.notes}
                value={details.notes}
                aria-invalid={detailErrors.notes ? true : undefined}
                aria-describedby={describedBy(fieldId("notes"), true, detailErrors.notes)}
                onChange={(event) => updateDetail("notes", event.target.value)}
              />
            </Field>
            <Honeypot id={fieldId("website")} value={details.website} onChange={(value) => updateDetail("website", value)} />

            {submitError ? <Notice tone="error">{submitError}</Notice> : null}

            <button type="submit" className="aiew-btn aiew-btn-primary aiew-btn-block" disabled={submitting} aria-busy={submitting || undefined}>
              {submitting ? "Sending…" : "Send me this estimate"}
            </button>
            <p className="aiew-hint">
              {config.emailsEnabled
                ? `We'll email you a copy, and ${config.businessName || "the business"} will be in touch.`
                : `${config.businessName || "The business"} will be in touch.`}
            </p>
          </form>
        </section>
      ) : null}

      {props.poweredBy ? <p className="aiew-powered">Powered by AdminIgloo</p> : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// The photo section
// ---------------------------------------------------------------------------

function PhotoSection({
  ids,
  tip,
  reads,
  photos,
  canAdd,
  error,
  onAdd,
  onRemove,
  onChangeCount,
}: {
  ids: string;
  tip: string | null;
  reads: boolean;
  photos: readonly PhotoItem[];
  canAdd: boolean;
  error: string | null;
  onAdd: (file: File) => void;
  onRemove: (localId: string) => void;
  /** Focus the field a reading filled in. */
  onChangeCount: (key: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const fileId = `${ids}-photo`;
  return (
    <section className="aiew-section" aria-labelledby={`${ids}-photos`} data-aiew-photos="">
      <h3 className="aiew-h3" id={`${ids}-photos`}>
        Add a photo <span className="aiew-optional">(optional)</span>
      </h3>
      <p className="aiew-desc">
        {reads ? "We'll count what we can see and fill it in for you. You can change it." : "The business sees it with your estimate."}
        {tip ? ` ${tip}` : ""}
      </p>
      {photos.length > 0 ? (
        <ul className="aiew-photos" aria-label="Your photos">
          {photos.map((photo, i) => (
            <li key={photo.localId} className="aiew-photo" data-aiew-photo={photo.localId}>
              <div className="aiew-stack-sm">
                <img className="aiew-thumb" src={photo.previewUrl} alt={`Your photo ${i + 1}`} />
                <button type="button" className="aiew-btn aiew-btn-secondary aiew-btn-sm" onClick={() => onRemove(photo.localId)}>
                  <CrossIcon />
                  Remove photo
                </button>
              </div>
              <div className="aiew-reading" aria-live="polite" data-aiew-reading={photo.reading ? photo.reading.status : undefined}>
                {photo.working ? (
                  <p className="aiew-row" role="status">
                    <span className="aiew-spinner aiew-spinner-sm" aria-hidden="true" />
                    {photo.workingLabel ?? "Working…"}
                  </p>
                ) : null}
                {photo.reading ? <ReadingCard reading={photo.reading} onChangeCount={onChangeCount} /> : null}
                {photo.notes.map((note, n) => (
                  <p key={n} className={note.tone === "ok" ? "aiew-row aiew-desc" : "aiew-desc"} data-aiew-photo-note={note.tone}>
                    {note.tone === "ok" ? <CheckIcon className="aiew-chip-check" /> : null}
                    {note.text}
                  </p>
                ))}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {canAdd ? (
        <div className="aiew-photo-actions">
          <input
            ref={inputRef}
            id={fileId}
            className="aiew-file"
            type="file"
            accept="image/*"
            capture="environment"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) onAdd(file);
            }}
          />
          <label htmlFor={fileId} className="aiew-btn aiew-btn-secondary" data-aiew-add-photo="">
            <CameraIcon />
            {photos.length > 0 ? "Add another photo" : "Add a photo"}
          </label>
        </div>
      ) : null}
    </section>
  );
}

/** The AI's reading, in the server's words, with how sure it is. */
function ReadingCard({ reading, onChangeCount }: { reading: TakeoffReading; onChangeCount: (key: string) => void }) {
  const tone = reading.confidence === "low" ? "aiew-tag aiew-tag-warn" : "aiew-tag aiew-tag-accent";
  // The field the reading filled in ("steps", "count"): the button goes to it.
  const filled = reading.status === "read" && reading.usable ? Object.keys(reading.suggested)[0] ?? null : null;
  return (
    <div className="aiew-stack-sm" data-aiew-reading-card="">
      <div className="aiew-row">
        <strong>What we see in your photo</strong>
        <span className={tone} data-aiew-confidence={reading.confidence}>
          {CONFIDENCE_LABEL[reading.confidence]}
        </span>
      </div>
      <ul className="aiew-reading-lines">
        {reading.lines.map((line, i) => (
          <li key={`${i}:${line}`}>{line}</li>
        ))}
      </ul>
      {filled ? (
        <button type="button" className="aiew-btn aiew-btn-secondary aiew-btn-sm" style={{ justifySelf: "start" }} onClick={() => onChangeCount(filled)} data-aiew-change-count="">
          Change the count
        </button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Saved
// ---------------------------------------------------------------------------

function Done({
  result,
  config,
  locale,
  price,
  name,
  photoCount,
  bookHref,
  headingRef,
  onStartOver,
  poweredBy,
}: {
  result: SubmitResponse;
  config: PublicConfig;
  locale: string;
  price: PublicPrice | null;
  name: string;
  photoCount: number;
  bookHref?: string;
  headingRef: Ref<HTMLHeadingElement>;
  onStartOver: () => void;
  poweredBy?: boolean;
}) {
  const titleId = useId();
  const first = firstName(name);
  const business = config.businessName || "The business";
  const range = formatRange(result.range.low, result.range.single ? result.range.low : result.range.high, result.currency, locale);
  const next: ReactNode[] = [
    `${business} looks over your estimate${photoCount > 0 ? ` and your photo${photoCount === 1 ? "" : "s"}` : ""}.`,
    "They'll get in touch to confirm the price, usually once they've seen the job.",
  ];
  return (
    <section className="aiew-done" aria-labelledby={titleId} data-aiew-done="">
      <div className="aiew-done-head">
        <span className="aiew-badge">
          <CheckIcon />
        </span>
        <h2 className="aiew-done-title" id={titleId} ref={headingRef} tabIndex={-1}>
          {first ? `Thanks, ${first}.` : "Thanks."} Your estimate {result.estimateNumber} is saved.
        </h2>
      </div>
      <p className="aiew-sub" data-aiew-emailed={result.emailed ? "yes" : "no"}>
        {result.emailed ? "We've emailed you a copy." : `Keep this reference: ${result.estimateNumber}.`}
      </p>
      <div className="aiew-price" data-aiew-recap="">
        <p className="aiew-price-label">Your estimate</p>
        <p className="aiew-amount">{range}</p>
        {price?.taxNote ? <p className="aiew-tax">{price.taxNote}</p> : null}
      </div>
      <div className="aiew-next">
        <h3 className="aiew-h3">What happens next</h3>
        <ul className="aiew-list">
          {next.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
          {config.contactPhone || config.contactEmail ? (
            <li>
              Questions before then? <ContactLinks phone={config.contactPhone} email={config.contactEmail} />
            </li>
          ) : null}
        </ul>
      </div>
      <div className="aiew-actions">
        {bookHref && result.estimateId ? (
          <a className="aiew-btn aiew-btn-primary" href={withParam(bookHref, "estimate", result.estimateId)} data-aiew-book="">
            Book a visit to measure
          </a>
        ) : null}
        <button type="button" className="aiew-btn aiew-btn-secondary" onClick={onStartOver}>
          Start another estimate
        </button>
      </div>
      {poweredBy ? <p className="aiew-powered">Powered by AdminIgloo</p> : null}
    </section>
  );
}
