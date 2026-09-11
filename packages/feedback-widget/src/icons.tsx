/**
 * The handful of icons the widget needs, inlined so lucide-react is not a
 * dependency the buyer inherits. All stroke-based, 24-unit viewBox,
 * currentColor — they take the button's text color automatically.
 */

import type { ReactElement, SVGProps } from "react";

function base(props: SVGProps<SVGSVGElement>) {
  return {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    ...props,
  };
}

export const IconMegaphone = (p: SVGProps<SVGSVGElement>): ReactElement => (
  <svg {...base(p)}>
    <path d="m3 11 18-5v12L3 13" />
    <path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" />
  </svg>
);

export const IconPencil = (p: SVGProps<SVGSVGElement>): ReactElement => (
  <svg {...base(p)}>
    <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
  </svg>
);

export const IconSquare = (p: SVGProps<SVGSVGElement>): ReactElement => (
  <svg {...base(p)}>
    <rect width="18" height="18" x="3" y="3" rx="2" />
  </svg>
);

export const IconCircle = (p: SVGProps<SVGSVGElement>): ReactElement => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="9" />
  </svg>
);

export const IconArrow = (p: SVGProps<SVGSVGElement>): ReactElement => (
  <svg {...base(p)}>
    <path d="M7 17 17 7" />
    <path d="M8 7h9v9" />
  </svg>
);

export const IconType = (p: SVGProps<SVGSVGElement>): ReactElement => (
  <svg {...base(p)}>
    <path d="M4 7V5h16v2" />
    <path d="M12 5v14" />
    <path d="M9 19h6" />
  </svg>
);

export const IconUndo = (p: SVGProps<SVGSVGElement>): ReactElement => (
  <svg {...base(p)}>
    <path d="M3 7v6h6" />
    <path d="M21 17a9 9 0 0 0-15-6.7L3 13" />
  </svg>
);

export const IconRedo = (p: SVGProps<SVGSVGElement>): ReactElement => (
  <svg {...base(p)}>
    <path d="M21 7v6h-6" />
    <path d="M3 17a9 9 0 0 1 15-6.7L21 13" />
  </svg>
);

export const IconTrash = (p: SVGProps<SVGSVGElement>): ReactElement => (
  <svg {...base(p)}>
    <path d="M3 6h18" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
);

export const IconX = (p: SVGProps<SVGSVGElement>): ReactElement => (
  <svg {...base(p)}>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </svg>
);

export const IconSend = (p: SVGProps<SVGSVGElement>): ReactElement => (
  <svg {...base(p)}>
    <path d="m22 2-7 20-4-9-9-4Z" />
    <path d="M22 2 11 13" />
  </svg>
);

export const IconCheck = (p: SVGProps<SVGSVGElement>): ReactElement => (
  <svg {...base(p)}>
    <path d="M20 6 9 17l-5-5" />
  </svg>
);
