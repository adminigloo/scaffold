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
      <table className={cx("w-full border-collapse text-sm", className)} {...rest} />
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
  return <tr className={cx("border-b border-line last:border-0", className)} {...rest} />;
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
