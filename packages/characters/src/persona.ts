import type { PersonaSections } from "./types.js";

/**
 * PERSONA SECTIONS, AND THE ONE PIECE OF THEM THAT'S GATED. Most of a `PersonaSections`
 * rides into a model's system prompt untouched — that's the host app's business, outside
 * this package. The one exception is `primerAt`: dated world knowledge that should reach
 * a visitor only once they're gated far enough to read it, the same rule `cardsFor`
 * applies to a card. These three helpers just pick the right half of her, so a world's
 * own prompt-building code never has to duplicate the `night ? … : …` and
 * `through >= primerAt.book` checks by hand.
 */

/** Which persona text applies right now: her other self's, or her usual one. */
export function personaFor(sections: Pick<PersonaSections, "persona" | "nightPersona">, night: boolean): string {
  return night ? sections.nightPersona : sections.persona;
}

/** Which checklist applies right now. */
export function checklistFor(sections: Pick<PersonaSections, "checklist" | "nightChecklist">, night: boolean): string {
  return night ? sections.nightChecklist : sections.checklist;
}

/**
 * Her primer, with the dated part added only once a visitor is gated far enough to read
 * it. Without a `primerAt`, or below its book, this is just `primer`. Past it, the
 * timeless primer and the dated news are joined by a blank line, the same as Hinderstap's
 * cached system prompt joined them.
 */
export function primerFor(sections: Pick<PersonaSections, "primer" | "primerAt">, through: number): string {
  const at = sections.primerAt;
  return at && through >= at.book ? `${sections.primer}\n${at.text}` : sections.primer;
}
