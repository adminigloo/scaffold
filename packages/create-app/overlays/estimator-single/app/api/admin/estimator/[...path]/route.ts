import { createEstimatorAdminHandlers } from "__SCOPE__/estimator";
import { db } from "@/db";
import { authorizeEstimatorStaff, estimatorUrls, reportEstimatorError } from "@/server/estimator";
import { ESTIMATOR_TENANT } from "@/server/estimator-staff";
import { estimatorDelivery, onEstimatorEvent } from "@/server/estimator-notify";
import {
  convertEstimateToInvoice,
  estimatorInvoiceAccess,
  estimatorLinkSeams,
  estimatorPhotoReadingOff,
  estimatorPhotoStore,
  estimatorTakeoff,
} from "@/server/estimator-services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The staff side of the estimator: what /admin/estimates, an estimate's own
 * page, the price book and Estimate settings talk to. The package's handler,
 * mounted behind this project's own sign-in and staff permissions.
 *
 * EVERY ROUTE ASKS `authorizeEstimatorStaff` for one of the package's five
 * permission keys before doing anything — signed out is a 401, not staff (or
 * staff without the key) is a 403. A route that could show a cost asks
 * `estimator.costs.view` as well, and without it every cost, labor rate and
 * margin is stripped: staff who quote see prices. The admin layout's gate is a
 * convenience for the pages; this is the boundary, because the API is
 * reachable without the pages.
 *
 * Never cross-origin: the handler sends no CORS headers and refuses a POST a
 * browser sent from another site, so a staff session cookie can't be used
 * from somewhere else.
 *
 * Staff sends, resends, revisions and status changes go through
 * `onEstimatorEvent` too, so the customer gets their quote (and the office its
 * notices) without anybody remembering to send them.
 *
 * What the screens need from the rest of this project, each from a module
 * generated for what was installed:
 *
 *   photoStore / photoReading  the customer's photo on the estimate, and whether
 *                              a model reads them (the status says when not,
 *                              and photoReadingOff says WHY: never installed,
 *                              no key, or a model with no price — so the
 *                              notice names the fix that works)
 *   delivery                   whether a quote is actually emailed, in words
 *   quoteUrl                   "Copy the quote link"
 *   links                      with --scheduling: "Book the visit" and the
 *                              visits booked from this estimate; with
 *                              --invoicing: the invoice it became
 *   convertToInvoice           with --invoicing: an accepted quote becomes an
 *                              invoice in one transaction, once
 *   embedBaseUrl               the address the website-embed snippet points at
 */
const admin = createEstimatorAdminHandlers({
  db,
  // The one business, with no database work: the handler resolves the tenant
  // before it authorizes, so the first-boot setup waits inside
  // authorizeEstimatorStaff until the caller is known to be staff.
  resolveTenant: () => ESTIMATOR_TENANT,
  authorize: authorizeEstimatorStaff,
  photoStore: estimatorPhotoStore,
  photoReading: Boolean(estimatorTakeoff),
  photoReadingOff: estimatorPhotoReadingOff,
  onEvent: onEstimatorEvent,
  quoteUrl: (token) => estimatorUrls.quote(token),
  delivery: () => estimatorDelivery(),
  links: estimatorLinkSeams,
  convertToInvoice: convertEstimateToInvoice,
  // "Turn into an invoice" asks the invoice staff key too (review SEC-2A-02).
  invoiceAccess: estimatorInvoiceAccess(),
  embedBaseUrl: estimatorUrls.embedBase,
  onError: reportEstimatorError,
});

export const GET = admin.handle;
export const POST = admin.handle;
