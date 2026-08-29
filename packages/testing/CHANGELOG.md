# @adminigloo/testing

## 0.1.0

### Minor Changes

- The helpers a generated project needs to test auth, permissions and Stripe with
  no live service.
  
  - `expectIdempotent` fires the same event twice and asserts exactly one side
    effect. Had it existed, both source repos' webhook bugs would have failed a
    test rather than reaching production.
  - Real signers, not stubs: `signStripePayload` is verified byte-for-byte against
    stripe-node's own generator, and `fakeIdentityProvider` signs with svix at the
    current time — a fixed timestamp makes the suite fail an hour later, which
    already happened here once.
  - `assertCatalogConformance` is what makes renaming a permission key safe:
    unknown references, unreachable keys, and stored grants pointing at a
    permission the catalog no longer declares.
  - `assertNotProduction` fails closed — it requires positive evidence that a
    target is disposable rather than trusting the absence of a red flag.
