/**
 * The "HH:MM" text formats, as patterns. Internal: `index.ts` exports them as
 * zod schemas (`timeOfDaySchema`, `endTimeSchema`), and the slot-id codec reads
 * the first.
 *
 * WHY THESE AND NOT `\d{2}:\d{2}`. That pattern accepted "16:99" and "99:99".
 * The overlap and duration math reads times through `timeToMinutes`, so
 * "16:99" is 17:39 there — while the hours check compared TEXT, where "16:99"
 * sorts before "17:00". A staff booking of 16:00–16:99 on a crew that stops at
 * 17:00 was accepted, stored as 99 minutes, and really ran to 17:39; the same
 * pattern let "99:99" be saved as working hours. A time is now a real time of
 * day, and the checks compare minutes.
 */

/** A time of day on a 24-hour clock, 00:00–23:59: a start, or an opening time. */
export const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * An end may also be "24:00" — midnight at the END of the day, so a crew can
 * work until midnight and a visit can run up to it. Never a start: a visit
 * starting at 24:00 starts on the next day.
 */
export const END_TIME_PATTERN = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;
