import type { ComponentProps } from "react";
import { cx } from "./cx";

/**
 * Rows separated by a hairline, never zebra striped.
 *
 * Striping encodes nothing — it is decoration that competes with the one thing
 * a table row is allowed to signal in colour, which is state (sealed, resolved,
 * failing). Keep the fill neutral and the meaning stays readable.
 *
 * The wrapper scrolls horizontally on its own so a wide table never makes the
 * whole page scroll sideways on a laptop.
 */
export function Table({ className, ...rest }: ComponentProps<"table">) {
  return (
    <div className="w-full overflow-x-auto">
      {/* tabular-nums so amounts, counts and timestamps line up down a column
          — proportional digits make a money column read like a ransom note. */}
      <table
        className={cx("w-full border-collapse text-sm tabular-nums", className)}
        {...rest}
      />
    </div>
  );
}

export function THead({ className, ...rest }: ComponentProps<"thead">) {
  return <thead className={cx("border-b border-line", className)} {...rest} />;
}

export function TBody(props: ComponentProps<"tbody">) {
  return <tbody {...props} />;
}

export function TR({ className, ...rest }: ComponentProps<"tr">) {
  // The hover wash is scoped to body rows by the `tbody &` variant — a header
  // row that lights up on hover advertises an interaction that does not exist.
  return (
    <tr
      className={cx(
        "border-b border-line transition-colors last:border-0 [tbody_&]:hover:bg-canvas/60",
        className,
      )}
      {...rest}
    />
  );
}

export function TH({ className, ...rest }: ComponentProps<"th">) {
  return (
    <th
      scope="col"
      className={cx(
        "px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-ink-muted",
        className,
      )}
      {...rest}
    />
  );
}

export function TD({ className, ...rest }: ComponentProps<"td">) {
  return <td className={cx("px-3 py-2 align-top", className)} {...rest} />;
}
