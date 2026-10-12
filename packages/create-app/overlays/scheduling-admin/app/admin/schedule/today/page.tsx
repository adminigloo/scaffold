import { CrewDay } from "__SCOPE__/scheduling-widget/admin";

export const dynamic = "force-dynamic";

/**
 * Today's route, for the crew, on a phone: the day's stops in order, each
 * address with a Directions link and a Call button, the drive from the stop
 * before, and Start and Complete buttons that update the office's calendar.
 *
 * Whose route: the crew whose "Who opens this crew's route" (Schedule
 * settings → Crews) is whoever opened this page — a crew member's own login
 * sees their own stops and nothing else. Somebody who sees every crew (the
 * owner checking on a van) gets a crew switcher, remembered on that device.
 * Start, Complete and "Couldn't do it" each have an Undo. Drive times come from Google when GOOGLE_MAPS_API_KEY is
 * set, and are marked as estimates when it is not.
 *
 * No page header on purpose: on a 390px screen the stops are the page.
 */
export default function TodaysRoutePage() {
  return <CrewDay baseUrl="/api/admin/schedule" />;
}
