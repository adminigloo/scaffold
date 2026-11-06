"use client";

import { lookKey, lookParts } from "../look-choices.js";
import type { LookChoices } from "../wire.js";

/** The dropdown entry that turns the switch on or off, where an option's key could never be. */
const TOGGLE = " toggle";

/**
 * THE LOOK, IN ONE DROPDOWN (social 0.7.2): the app's options (its
 * backgrounds) and, after them, the entry that turns its switch on or off
 * ("Turn on confetti" / "Turn off confetti"). Riddler Go's owner, 2026-11-05:
 * "i'd rather have a dropdown that swaps the background ... you could also
 * have it say turn on confetti and turn off confettie", then "i wanted them
 * all in the same drop down". The chosen option says when the switch is on
 * ("Blue + confetti"). A post made before the looks reads "Plain" until a
 * background is chosen. A 44px target.
 */
export function LookControls({
  id,
  choices,
  value,
  onChange,
  disabled = false,
}: {
  /** A prefix for the control's id. */
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
          if (next === TOGGLE) {
            if (option) onChange(lookKey(choices, option, !on));
          } else if (next && next !== option) onChange(lookKey(choices, next, on));
        }}
      >
        {option ? null : <option value="">{value ? "Its own" : "Plain"}</option>}
        {choices.options.map((o) => (
          <option key={o.key} value={o.key}>
            {o.key === option && on && toggle?.label ? `${o.name} + ${toggle.label}` : o.name}
          </option>
        ))}
        {toggle && option ? (
          <optgroup label={toggle.label ? toggle.label.charAt(0).toUpperCase() + toggle.label.slice(1) : " "}>
            <option value={TOGGLE}>{on ? toggle.turnOff : toggle.turnOn}</option>
          </optgroup>
        ) : null}
      </select>
    </div>
  );
}
