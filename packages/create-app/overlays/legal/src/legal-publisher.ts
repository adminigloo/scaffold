/**
 * The facts about the BUSINESS that the two legal pages need, and that no
 * generator can know.
 *
 * THE OTHER HALF OF `src/legal.ts`, and the split is deliberate. That file is
 * generated: who else sees a customer's data, and which clauses follow from
 * what this project was built out of. Those are facts about the software, so
 * they are derived and must not be edited. Everything here is a fact about the
 * company behind it — its name, where a data request goes, whose courts hear a
 * dispute — so it is copied source with obvious placeholders in it.
 *
 * IT IS DELIBERATELY NOT PLAUSIBLE. Every value below is either empty or says
 * the word PLACEHOLDER, because the alternative — "Acme Ltd, 1 Example Street"
 * — is a legal page that reads as finished and ships to production looking
 * correct. An empty field renders as a visible gap on the page; a plausible
 * wrong one renders as a lie a regulator can hold you to.
 *
 * WHAT TO DO WITH IT: fill these in, then have a lawyer read the two pages.
 * They are a starting point that is accurate about the software and says
 * nothing at all about whether your processing is lawful.
 */
export interface Publisher {
  /** The entity a customer is contracting with. Not the product's name. */
  readonly legalName: string;
  /** The name customers know you by, if it differs. */
  readonly tradingName: string;
  /** Registered address, as it must appear on a contract. */
  readonly address: string;
  /** Where a privacy request, a complaint or a legal notice goes. */
  readonly contactEmail: string;
  /** "the laws of England and Wales", "the State of Delaware", and so on. */
  readonly governingLaw: string;
  /**
   * The date this version of the documents took effect, as you want it read:
   * "1 September 2026".
   *
   * EMPTY UNTIL YOU PUBLISH, and the pages say so rather than printing today's
   * date. A generated date would be the date the project was scaffolded, which
   * is not the date anybody agreed to anything — and a policy carrying a
   * confident date nobody chose is worse than one that admits it is a draft.
   */
  readonly effectiveDate: string;
}

export const PUBLISHER: Publisher = {
  legalName: "PLACEHOLDER — the registered company name",
  tradingName: "__PROJECT_NAME__",
  address: "PLACEHOLDER — registered address",
  contactEmail: "",
  governingLaw: "PLACEHOLDER — the law these terms are governed by",
  effectiveDate: "",
};
