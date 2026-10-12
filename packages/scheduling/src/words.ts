/**
 * Words staff read, pure. The refusals and warnings a staff screen shows as
 * they come ("Crew A doesn't work on Saturday, November 7") are built here, in
 * the business's own 12-hour clock, from the crew's name — never "Resource is
 * not available on this day" or "18:00–19:00 is outside availability
 * (08:00–17:00)", which read as a software error to a business owner.
 *
 * English, like every other message the package writes; the date and time
 * shapes follow en-US ("9:00 AM", "Saturday, November 7").
 */

/** "18:00" → "6:00 PM"; "24:00" → "midnight"; "00:00" → "12:00 AM". Anything else is returned as given. */
export function clock12(time: string): string {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return time;
  const hours = Number(match[1]);
  const minutes = match[2] as string;
  if (hours === 24) return "midnight";
  const suffix = hours < 12 ? "AM" : "PM";
  const twelve = hours % 12 === 0 ? 12 : hours % 12;
  return `${twelve}:${minutes} ${suffix}`;
}

/** "08:00", "17:00" → "8:00 AM – 5:00 PM". */
export function range12(start: string, end: string): string {
  return `${clock12(start)} – ${clock12(end)}`;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/** A label Date (the day's UTC midnight) → "Saturday, November 7". */
export function dayWords(label: Date): string {
  return `${WEEKDAYS[label.getUTCDay()]}, ${MONTHS[label.getUTCMonth()]} ${label.getUTCDate()}`;
}

/** A label Date → "Saturdays", for "works … on Saturdays". */
export function weekdaysWord(label: Date): string {
  return `${WEEKDAYS[label.getUTCDay()]}s`;
}

/** A crew's name for a sentence, or "This crew" when it has none on record. */
export function crewWord(name: string | null | undefined): string {
  const trimmed = name?.trim();
  return trimmed ? trimmed : "This crew";
}
