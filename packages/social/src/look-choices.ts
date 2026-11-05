import type { LookChoices } from "./wire.js";

/**
 * A LOOK AS TWO CHOICES (social 0.7): one of the app's list (its backgrounds,
 * say) and, if it has one, a switch that adds something over any of them
 * (its confetti). The look's key is the option's, with the switch's suffix
 * when it's on: "spray", "spray-confetti". Pure: the screens and the handler
 * both read it.
 */

/** Every look the choices make: each option, and each with the switch on. */
export function lookKeys(choices: LookChoices): string[] {
  return choices.options.flatMap((o) => (choices.toggle ? [o.key, `${o.key}${choices.toggle.suffix}`] : [o.key]));
}

/** The look for an option, with the switch on or off. */
export function lookKey(choices: LookChoices, option: string, on: boolean): string {
  return on && choices.toggle ? `${option}${choices.toggle.suffix}` : option;
}

/** Which option a look is, and whether its switch is on; null for a look the choices don't make ("" for none). */
export function lookParts(choices: LookChoices, key: string): { readonly option: string; readonly on: boolean } | null {
  if (!key) return null;
  if (choices.options.some((o) => o.key === key)) return { option: key, on: false };
  const suffix = choices.toggle?.suffix;
  if (suffix && key.endsWith(suffix)) {
    const option = key.slice(0, -suffix.length);
    if (choices.options.some((o) => o.key === option)) return { option, on: true };
  }
  return null;
}

/** The look a sample opens on: the first option, its switch on (what the switch adds is the look's biggest difference). */
export function firstLook(choices: LookChoices): string | null {
  const first = choices.options[0];
  return first ? lookKey(choices, first.key, true) : null;
}
