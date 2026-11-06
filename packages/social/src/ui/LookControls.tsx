"use client";

import { lookKey, lookParts } from "../look-choices.js";
import type { LookChoices } from "../wire.js";

/**
 * THE LOOK, AS TWO CONTROLS (social 0.7): a dropdown of the app's options
 * (its backgrounds) and a button for its switch ("Turn on confetti" / "Turn
 * off confetti"), where a long list of every pairing was too much to read
 * (Riddler Go's owner, 2026-11-05: "i'd rather have a dropdown that swaps the
 * background ... it looks like the background with and without confettie are
 * the biggest differences"). A post made before the looks reads "Plain" until
 * a background is chosen. Each control is a 44px target.
 */
export function LookControls({
  id,
  choices,
  value,
  onChange,
  disabled = false,
}: {
  /** A prefix for the controls' ids. */
  readonly id: string;
  readonly choices: LookChoices;
  /** The look now: a key the choices make, or "" (or another key) for none of them. */
  readonly value: string;
  readonly onChange: (look: string) => void;
  readonly disabled?: boolean;
}) {
  const parts = lookParts(choices, value);
  const option = parts?.option ?? "";
  const on = parts?.on ?? false;
  const toggle = choices.toggle;
  return (
    <div className="social-look">
      <label htmlFor={`${id}-option`}>{choices.label}</label>
      <select
        id={`${id}-option`}
        className="social-select"
        value={option}
        disabled={disabled}
        onChange={(e) => {
          const next = e.target.value;
          if (next && next !== option) onChange(lookKey(choices, next, on));
        }}
      >
        {option ? null : <option value="">{value ? "Its own" : "Plain"}</option>}
        {choices.options.map((o) => (
          <option key={o.key} value={o.key}>
            {o.name}
          </option>
        ))}
      </select>
      {toggle ? (
        <button type="button" className="social-button" disabled={disabled || !option} onClick={() => onChange(lookKey(choices, option, !on))}>
          {on ? toggle.turnOff : toggle.turnOn}
        </button>
      ) : null}
    </div>
  );
}
