import type { ReactNode } from "react";
import { PageHeader } from "./PageHeader";

/** The work area's width and gutters: every company page, the same. */
export const WORK_MAIN = "mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 lg:px-8";

/**
 * THE ONE SHAPE OF A WORK-AREA PAGE: the same width, the same gutters and the
 * same header on every company screen, so moving from Schedule to Invoices
 * reads as one product instead of nine.
 *
 *   - max-w-6xl inside the work area: wide enough to use a laptop's screen,
 *     narrow enough that a line of text stays readable. A form that should be
 *     narrower narrows itself inside the page; the page never does.
 *   - PageHeader: title, one line saying what this screen is for, and the
 *     page's primary action on the right.
 *   - `notices` sit under the header and above the work: the page's ONE
 *     "things to finish" card (<SetupNotices>), never a stack of banners.
 */
export function WorkPage({
  title,
  description,
  actions,
  notices,
  children,
}: {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly notices?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <main className={WORK_MAIN}>
      <PageHeader title={title} description={description} actions={actions} />
      {notices ? <div className="mb-6">{notices}</div> : null}
      {children}
    </main>
  );
}
