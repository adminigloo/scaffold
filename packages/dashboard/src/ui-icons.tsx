import type { ReactElement } from "react";
import type { IconName } from "./widget.js";

/**
 * The dashboard's drawings: one stroke weight, one size, `currentColor`, so a
 * card's icon takes the colour of the text around it in either theme. Paths on
 * a 24-unit grid, drawn for this package.
 */
const FEATURE: Record<IconName, string> = {
  board: "M4 4h4v16H4z M10 4h4v10h-4z M16 4h4v13h-4z",
  chart: "M4 20V11 M10 20V5 M16 20v-8 M3 20h18",
  phone:
    "M5 4h3.5l2 5-2.6 1.7a11 11 0 0 0 5.4 5.4L15 13.5l5 2V19a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z",
  alert: "M12 3.5 2.5 20h19L12 3.5z M12 10v4.5 M12 17.5h.01",
  building: "M4 21V4h10v17 M14 9h6v12 M7.5 8h3 M7.5 12h3 M7.5 16h3 M3 21h18",
  people: "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M2 21a7 7 0 0 1 14 0 M16.5 3.6a4 4 0 0 1 0 7 M22 21a6.5 6.5 0 0 0-4.2-6",
  shield: "M12 3l8 3v6c0 5-3.4 8-8 9-4.6-1-8-4-8-9V6l8-3z M8.5 12l2.5 2.5 4.5-5",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z M21 21l-5-5",
  sparkle: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z",
  chat: "M4 5h16v11H9.5L4 20V5z M8 9.5h8 M8 12.5h5",
  cart: "M3 4h2.2l2.3 11h10.8L21 7.5H6.4 M9 20h.01 M18 20h.01",
  card: "M3 6h18v12H3z M3 10h18 M7 15h3",
  receipt: "M6 3h12v18l-3-2-3 2-3-2-3 2V3z M9 8h6 M9 12h6 M9 16h3",
  calendar: "M4 6h16v14H4z M4 10h16 M8 3v4 M16 3v4",
  file: "M6 3h8l4 4v14H6z M14 3v4h4",
  bell: "M6 16v-5a6 6 0 1 1 12 0v5l2 2H4z M10 20.5a2 2 0 0 0 4 0",
  mail: "M3 6h18v12H3z M3.5 6.5l8.5 6.5 8.5-6.5",
  tag: "M3 12.5V4h8.5L21 13.5 13.5 21z M7.5 7.5h.01",
  list: "M9 6h12 M9 12h12 M9 18h12 M4 6h.01 M4 12h.01 M4 18h.01",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
};

const UI = {
  star: "M12 3.2l2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 17l-5.4 2.9 1.1-6.1-4.5-4.2 6.1-.8z",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7 M20 4v7h-7",
  open: "M14 4h6v6 M20 4l-9 9 M18 14v6H4V6h6",
  close: "M6 6l12 12 M18 6L6 18",
  grip: "M9 6h.01 M15 6h.01 M9 12h.01 M15 12h.01 M9 18h.01 M15 18h.01",
  left: "M15 5l-7 7 7 7",
  right: "M9 5l7 7-7 7",
  customize: "M4 7h10 M18 7h2 M4 17h4 M12 17h8 M16 4.5v5 M10 14.5v5",
  check: "M5 12.5l4.5 4.5L19 7.5",
  good: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M8 12.5l3 3 5-6",
  warn: "M12 3.5 2.5 20h19L12 3.5z M12 10v4.5 M12 17.5h.01",
  bad: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M9 9l6 6 M15 9l-6 6",
  neutral: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 11v5 M12 8h.01",
  undo: "M9 14L4 9l5-5 M4 9h11a5 5 0 0 1 0 10h-3",
} as const;

export type UiIconName = keyof typeof UI;

function Svg({ d, size, fill }: { d: string; size: number; fill?: boolean }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="aid-svg"
    >
      <path d={d} />
    </svg>
  );
}

export function FeatureIcon({ name, size = 16 }: { name: IconName; size?: number }): ReactElement {
  return <Svg d={FEATURE[name] ?? FEATURE.list} size={size} />;
}

export function UiIcon({ name, size = 16, fill }: { name: UiIconName; size?: number; fill?: boolean }): ReactElement {
  return <Svg d={UI[name]} size={size} fill={fill} />;
}
