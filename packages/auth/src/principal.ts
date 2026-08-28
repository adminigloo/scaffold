/**
 * Who is making this request.
 *
 * The single contract between identity and everything downstream.
 * `@adminigloo/permissions` resolves against `userId` and knows nothing about
 * where it came from — which is what lets one engine gate both the staff
 * surface and the tenant surface, and what keeps authorization independent of
 * the identity provider.
 */
export interface Principal {
  /** Our `users.id`, never the provider's. */
  readonly userId: string;
  /** The provider's id, for calling back into the provider's API. */
  readonly externalId: string;
  readonly email: string | null;
  /**
   * Set when a staff member is acting as this user.
   *
   * Every permission resolution with this set writes an audit row flagged as
   * sensitive access. Impersonation that is not logged is indistinguishable
   * from a compromised account after the fact.
   */
  readonly impersonatedBy?: string | null;
}

export function isImpersonating(principal: Principal): boolean {
  return (
    principal.impersonatedBy !== null && principal.impersonatedBy !== undefined
  );
}
