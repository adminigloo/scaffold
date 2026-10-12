import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { CheckIcon, ChevronIcon, describedBy, SparkIcon } from "./parts.js";
import type { ChoiceField, CustomerField, CustomerInputs, NumberField, StepperField } from "./types.js";

/**
 * <CustomerFields> — what the customer is asked, rendered from the SERVER's
 * field specs (contract 3 / 9.3). Nothing here knows what a ramp or a step is:
 * the labels, the help, the limits, the units and which questions sit behind
 * "More ways to measure" all come from `fields`. A recipe the server adds
 * tomorrow renders today. The same component is the price book's live
 * preview of "what your customer is asked", so the owner sees exactly this.
 *
 * Inputs start EMPTY (ES-14: 0.1 pre-filled 36 × 30 in and 20 ft, so a price
 * showed before anyone measured anything).
 */

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** The plain sentence for a number outside a field's limits. */
export function rangeMessage(field: { min: number; max: number }): string {
  return `Enter a number from ${field.min} to ${field.max}.`;
}

/** Is `value` acceptable for `field` (finite, inside its limits; a stepper's a whole number)? */
export function inRange(field: StepperField | NumberField, value: number): boolean {
  if (!Number.isFinite(value) || value < field.min || value > field.max) return false;
  return field.kind === "stepper" ? Number.isInteger(value) : true;
}

/**
 * The inputs worth sending: the stepper and number fields' values that are
 * inside their limits. A choice field is how the customer fills the others
 * (a preset size), never an input itself; a half-typed or out-of-range number
 * stays on the screen with its message and off the wire, so the server
 * answers "needs inputs" rather than an error.
 */
export function cleanInputs(fields: readonly CustomerField[], values: CustomerInputs): CustomerInputs {
  const out: CustomerInputs = {};
  for (const field of fields) {
    if (field.kind === "choice") continue;
    const value = values[field.key];
    if (typeof value === "number" && inRange(field, value)) out[field.key] = value;
  }
  return out;
}

/** True when the customer has answered anything at all (so there is something to price). */
export function hasAnyInput(fields: readonly CustomerField[], values: CustomerInputs): boolean {
  return Object.keys(cleanInputs(fields, values)).length > 0;
}

/** Parse what was typed: "" → null; "7.5" / "7,5" → 7.5; anything else → NaN. */
export function parseTyped(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed.replace(",", "."));
  return Number.isFinite(n) ? n : Number.NaN;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// ---------------------------------------------------------------------------
// Radio chips (products, options, preset sizes)
// ---------------------------------------------------------------------------

export interface ChipChoice {
  value: string;
  label: ReactNode;
  /** Text after the label ("+$120"). */
  extra?: ReactNode;
  /** The accessible name, when `label` isn't plain text. */
  name?: string;
}

/**
 * A row of chips with radio semantics: one tab stop (the checked chip, or the
 * first), arrow keys move AND choose, Space/Enter choose. Never colour alone:
 * the checked chip carries a check mark too.
 */
export function RadioChips({
  choices,
  value,
  onChange,
  labelledBy,
  label,
  disabled,
  data,
}: {
  choices: readonly ChipChoice[];
  value: string | null;
  onChange: (value: string) => void;
  labelledBy?: string;
  label?: string;
  disabled?: boolean;
  data?: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const checkedIndex = choices.findIndex((c) => c.value === value);
  const tabIndexFor = (i: number) => (checkedIndex >= 0 ? (i === checkedIndex ? 0 : -1) : i === 0 ? 0 : -1);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const delta = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (delta === 0) {
      if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        const target = event.key === "Home" ? 0 : choices.length - 1;
        refs.current[target]?.focus();
        onChange(choices[target]!.value);
      }
      return;
    }
    event.preventDefault();
    const next = (i + delta + choices.length) % choices.length;
    refs.current[next]?.focus();
    onChange(choices[next]!.value);
  };
  return (
    <div className="aiew-chips" role="radiogroup" aria-labelledby={labelledBy} aria-label={labelledBy ? undefined : label} data-aiew-chips={data}>
      {choices.map((choice, i) => (
        <button
          key={choice.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          className="aiew-chip"
          aria-checked={choice.value === value}
          aria-label={choice.name}
          tabIndex={tabIndexFor(i)}
          disabled={disabled}
          data-value={choice.value}
          onClick={() => onChange(choice.value)}
          onKeyDown={(event) => onKeyDown(event, i)}
        >
          <CheckIcon className="aiew-chip-check" />
          <span>{choice.label}</span>
          {choice.extra ? <span className="aiew-mod">{choice.extra}</span> : null}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The stepper and the number input
// ---------------------------------------------------------------------------

/**
 * − value + : 44 px buttons and an editable number in between. Empty until the
 * customer answers ("+" from empty is the minimum). What is typed is kept as
 * typed until the field loses focus, then clamped to the limits.
 */
export function Stepper({
  id,
  label,
  value,
  min,
  max,
  onValue,
  invalid,
  describedById,
  disabled,
}: {
  id: string;
  label: string;
  value: number | null;
  min: number;
  max: number;
  onValue: (value: number | null) => void;
  invalid?: boolean;
  describedById?: string;
  disabled?: boolean;
}) {
  const [text, setText] = useState(value === null ? "" : String(value));
  useEffect(() => {
    const typed = parseTyped(text);
    if (value === null ? typed !== null : typed !== value) setText(value === null ? "" : String(value));
    // Only an outside change (a button, the photo, a reset) rewrites the text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  // The value as of the last tap, not the last render: two quick taps before
  // React re-renders must count as two.
  const latest = useRef(value);
  latest.current = value;
  const step = (delta: number) => {
    const current = latest.current;
    const next = current === null ? min : clamp(Math.round(current) + delta, min, max);
    latest.current = next;
    setText(String(next));
    onValue(next);
  };
  return (
    <div className="aiew-stepper" data-aiew-stepper={id}>
      <button
        type="button"
        className="aiew-stepper-btn"
        aria-label={`One fewer: ${label}`}
        aria-controls={id}
        disabled={disabled || value === null || value <= min}
        onClick={() => step(-1)}
      >
        −
      </button>
      <input
        id={id}
        className="aiew-input"
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete="off"
        aria-label={label}
        aria-invalid={invalid || undefined}
        aria-describedby={describedById}
        disabled={disabled}
        value={text}
        onChange={(event) => {
          const raw = event.target.value.replace(/[^\d]/g, "");
          setText(raw);
          const typed = parseTyped(raw);
          onValue(typed === null || Number.isNaN(typed) ? null : typed);
        }}
        onBlur={() => {
          const typed = parseTyped(text);
          if (typed === null || Number.isNaN(typed)) return;
          const clamped = clamp(Math.round(typed), min, max);
          if (clamped !== typed) {
            setText(String(clamped));
            onValue(clamped);
          }
        }}
      />
      <button
        type="button"
        className="aiew-stepper-btn"
        aria-label={`One more: ${label}`}
        aria-controls={id}
        disabled={disabled || (value !== null && value >= max)}
        onClick={() => step(1)}
      >
        +
      </button>
    </div>
  );
}

function NumberInput({
  id,
  field,
  value,
  onValue,
  error,
  hasHint,
  describedById,
  disabled,
}: {
  id: string;
  field: NumberField;
  value: number | null;
  onValue: (value: number | null) => void;
  error: string | null;
  hasHint: boolean;
  describedById?: string;
  disabled?: boolean;
}) {
  const [text, setText] = useState(value === null ? "" : String(value));
  useEffect(() => {
    const typed = parseTyped(text);
    if (value === null ? typed !== null && !Number.isNaN(typed) : typed !== value) setText(value === null ? "" : String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const input = (
    <input
      id={id}
      className="aiew-input"
      type="text"
      inputMode="decimal"
      autoComplete="off"
      placeholder={field.placeholder ?? undefined}
      aria-invalid={error ? true : undefined}
      aria-describedby={describedById ?? describedBy(id, hasHint, error)}
      aria-required={field.required || undefined}
      disabled={disabled}
      value={text}
      onChange={(event) => {
        setText(event.target.value);
        const typed = parseTyped(event.target.value);
        onValue(typed === null || Number.isNaN(typed) ? null : typed);
      }}
    />
  );
  if (!field.unit) return input;
  return (
    <div className="aiew-input-unit">
      {input}
      <span className="aiew-unit" aria-hidden="true">
        {field.unit}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// <CustomerFields>
// ---------------------------------------------------------------------------

export interface CustomerFieldsProps {
  /** The server's field specs, in render order. */
  fields: readonly CustomerField[];
  values: CustomerInputs;
  /** `next` is the whole set of values; `changed` the keys this edit touched (a preset sets two). */
  onChange: (next: CustomerInputs, changed: string[]) => void;
  /** Messages per field key (the server's issues, mapped). Shown under the field. */
  errors?: Readonly<Record<string, string>>;
  /** A small tag per field key, e.g. { steps: "From your photo" }: where a value came from. */
  readOnlyBadges?: Readonly<Record<string, string>>;
  /**
   * A question to check an answer by, per field key, shown under the field and
   * read with it. Not an error: the value stays and is priced. The estimate
   * tool uses it when the customer lowers the count a photo filled in ("Did
   * you count the step up onto the porch?", review EST-R04).
   */
  checks?: Readonly<Record<string, string>>;
  disabled?: boolean;
  /** The disclosure's words. Default "More ways to measure". */
  moreLabel?: string;
}

export function CustomerFields({ fields, values, onChange, errors, readOnlyBadges, checks, disabled, moreLabel = "More ways to measure" }: CustomerFieldsProps) {
  const ids = useId();
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [bad, setBad] = useState<Record<string, boolean>>({});
  const [moreOpen, setMoreOpen] = useState(false);
  const primary = fields.filter((f) => f.presentation !== "secondary");
  const secondary = fields.filter((f) => f.presentation === "secondary");
  const secondaryHasValue = secondary.some((f) => f.kind !== "choice" && typeof values[f.key] === "number");
  const showMore = moreOpen || secondaryHasValue;

  const set = (key: string, value: number | null) => onChange({ ...values, [key]: value }, [key]);

  const errorFor = (field: CustomerField): string | null => {
    const external = errors?.[field.key];
    if (external) return external;
    if (field.kind === "choice" || !touched[field.key]) return null;
    const value = values[field.key];
    if (bad[field.key] || (typeof value === "number" && !inRange(field, value))) return rangeMessage(field);
    return null;
  };

  const render = (field: CustomerField) => {
    const id = `${ids}-${field.key}`;
    const error = errorFor(field);
    const badgeText = readOnlyBadges?.[field.key];
    const badge = badgeText ? (
      <span className="aiew-badge-photo" data-aiew-badge={field.key}>
        <SparkIcon />
        {badgeText}
      </span>
    ) : null;
    const optional = !field.required && !/\(optional\)\s*$/i.test(field.label);
    const check = checks?.[field.key] ?? null;
    const described = [describedBy(id, Boolean(field.help), error), check ? `${id}-check` : null].filter(Boolean).join(" ") || undefined;
    if (field.kind === "choice") return <ChoiceInput key={field.key} id={id} field={field} values={values} onChange={onChange} disabled={disabled} />;
    return (
      <div
        key={field.key}
        className="aiew-field"
        data-aiew-field={field.key}
        onBlur={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setTouched((t) => (t[field.key] ? t : { ...t, [field.key]: true }));
          const input = event.currentTarget.querySelector("input");
          const typed = input ? parseTyped(input.value) : null;
          setBad((b) => ({ ...b, [field.key]: typeof typed === "number" && Number.isNaN(typed) }));
        }}
      >
        <label className="aiew-label" htmlFor={id}>
          <span>
            {field.label} {optional ? <span className="aiew-optional">(optional)</span> : null}
          </span>
          {badge}
        </label>
        {field.kind === "stepper" ? (
          <Stepper
            id={id}
            label={field.label}
            value={values[field.key] ?? null}
            min={field.min}
            max={field.max}
            onValue={(value) => set(field.key, value)}
            invalid={Boolean(error)}
            describedById={described}
            disabled={disabled}
          />
        ) : (
          <NumberInput
            id={id}
            field={field}
            value={values[field.key] ?? null}
            onValue={(value) => set(field.key, value)}
            error={error}
            hasHint={Boolean(field.help)}
            describedById={described}
            disabled={disabled}
          />
        )}
        {field.help ? (
          <span className="aiew-hint" id={`${id}-hint`}>
            {field.help}
          </span>
        ) : null}
        {error ? (
          <span className="aiew-field-error" id={`${id}-error`}>
            {error}
          </span>
        ) : null}
        {check ? (
          <span className="aiew-field-check" id={`${id}-check`} role="status" data-aiew-check={field.key}>
            {check}
          </span>
        ) : null}
      </div>
    );
  };

  const moreId = `${ids}-more`;
  return (
    <div className="aiew-fields" data-aiew-fields="">
      {primary.map(render)}
      {secondary.length > 0 ? (
        <div className="aiew-more">
          <button
            type="button"
            className="aiew-disclosure"
            aria-expanded={showMore}
            aria-controls={moreId}
            onClick={() => setMoreOpen((open) => !open)}
          >
            <ChevronIcon />
            {moreLabel}
          </button>
          <div id={moreId} className="aiew-fields" hidden={!showMore} data-aiew-more="">
            {secondary.map(render)}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A choice field: chips that COPY their `sets` into the other fields (a
 * preset size fills width and length), which stay editable. The chip reads as
 * chosen while the fields still hold its numbers — no state of its own.
 */
function ChoiceInput({
  id,
  field,
  values,
  onChange,
  disabled,
}: {
  id: string;
  field: ChoiceField;
  values: CustomerInputs;
  onChange: (next: CustomerInputs, changed: string[]) => void;
  disabled?: boolean;
}) {
  const chosen = field.choices.find((c) => Object.keys(c.sets).length > 0 && Object.entries(c.sets).every(([k, v]) => values[k] === v)) ?? null;
  return (
    <div className="aiew-field" data-aiew-field={field.key}>
      <span className="aiew-label" id={`${id}-label`}>
        {field.label}
      </span>
      <RadioChips
        labelledBy={`${id}-label`}
        choices={field.choices.map((c) => ({ value: c.value, label: c.label }))}
        value={chosen?.value ?? null}
        disabled={disabled}
        onChange={(value) => {
          const choice = field.choices.find((c) => c.value === value);
          if (choice) onChange({ ...values, ...choice.sets }, Object.keys(choice.sets));
        }}
      />
      {field.help ? <span className="aiew-hint">{field.help}</span> : null}
    </div>
  );
}
