import { existsSync } from "node:fs";
import { join } from "node:path";
import { cx } from "@/components/ui";
import { SCREENSHOTS } from "@/marketing-copy";

/**
 * A product screenshot — ONLY when its file is there. Save the PNGs named in
 * SCREENSHOTS (src/marketing-copy.ts) in public/screenshots/ and they appear;
 * until then the slot renders nothing at all: no gap, no grey box, no broken
 * image icon on the page a prospect reads first.
 */
export function Screenshot({ slot, className }: { readonly slot: keyof typeof SCREENSHOTS; readonly className?: string }) {
  const shot = SCREENSHOTS[slot] as { readonly file: string; readonly alt: string } | undefined;
  if (!shot) return null;
  if (!existsSync(join(process.cwd(), "public", "screenshots", shot.file))) return null;
  return (
    <figure className={cx("m-0", className)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`/screenshots/${shot.file}`}
        alt={shot.alt}
        className="block w-full rounded-[--radius-card] border border-line bg-surface shadow-raised"
        loading="lazy"
      />
    </figure>
  );
}
