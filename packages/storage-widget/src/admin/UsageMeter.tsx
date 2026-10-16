import type { ReactNode } from "react";
import type { UsageWire } from "../types.js";
import { Root, type ChromeProps } from "../ui.js";
import { usageNote, usageSentence, usageTone } from "./words.js";

/**
 * "Using 120 MB of 5 GB", with a bar (section 7). At 90 % or more the bar
 * turns the warning colour and says "Almost full: delete files you no longer
 * need."; full, it says what can't happen now and who to ask for more room
 * (review BO-07: the platform's name, so an owner knows who that is; review
 * BO-6: and the address to write to, as a link). Someone who can't remove
 * files (`canMakeRoom={false}`) is told to ask the owner instead (review
 * BO-9). With no allowance, just "Using 120 MB".
 *
 *   <UsageMeter usage={usage} platformName="Igloo Back Office" supportEmail="help@igloo.example" />
 */

export interface UsageMeterProps extends ChromeProps {
  usage: UsageWire;
  /** Who to ask for more room, in the full sentence. */
  platformName?: string;
  /** Review BO-6: the address to write to for more room, shown as a link. */
  supportEmail?: string;
  /** Review BO-9: can the reader remove files? Default true; false: "Full: ask the owner to make room." */
  canMakeRoom?: boolean;
  locale?: string;
}

export interface MeterBodyProps {
  usage: UsageWire;
  platformName?: string | undefined;
  supportEmail?: string | undefined;
  canMakeRoom?: boolean | undefined;
  /** Review BO-10: a file was just refused because storage is full. */
  refusedFull?: boolean | undefined;
  locale?: string | undefined;
}

/** The note, with the support address as a mailto link (review BO-6). */
function withEmailLink(note: string, email: string | undefined): ReactNode {
  const address = email?.trim();
  const at = address ? note.indexOf(address) : -1;
  if (!address || at < 0) return note;
  return (
    <>
      {note.slice(0, at)}
      <a href={`mailto:${address}`}>{address}</a>
      {note.slice(at + address.length)}
    </>
  );
}

/** The meter without its own root, for a screen that already has one. */
export function MeterBody({ usage, platformName, supportEmail, canMakeRoom, refusedFull, locale }: MeterBodyProps) {
  const tone = usageTone(usage, refusedFull === true);
  const sentence = usageSentence(usage, locale);
  const note = usageNote(usage, platformName, { supportEmail, canMakeRoom, refusedFull });
  if (tone === "none" || usage.allowanceBytes === null) {
    return (
      <div className="aifw-meter" data-tone="none">
        <span className="aifw-meter-label">{sentence}</span>
      </div>
    );
  }
  const share = Math.min(1, usage.usedBytes / usage.allowanceBytes);
  return (
    <div className="aifw-meter" data-tone={tone}>
      <span className="aifw-meter-label">
        {sentence}
      </span>
      <div
        className="aifw-meter-track"
        role="meter"
        aria-label="Storage used"
        aria-valuemin={0}
        aria-valuemax={usage.allowanceBytes}
        aria-valuenow={Math.min(usage.usedBytes, usage.allowanceBytes)}
        aria-valuetext={sentence}
      >
        <div className="aifw-meter-fill" style={{ width: `${Math.round(share * 1000) / 10}%` }} />
      </div>
      {note ? <span className="aifw-meter-note">{withEmailLink(note, supportEmail)}</span> : null}
    </div>
  );
}

export function UsageMeter(props: UsageMeterProps) {
  const { usage, platformName, supportEmail, canMakeRoom, locale, ...chrome } = props;
  return (
    <Root {...chrome}>
      <MeterBody usage={usage} platformName={platformName} supportEmail={supportEmail} canMakeRoom={canMakeRoom} locale={locale} />
    </Root>
  );
}
