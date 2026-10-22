import { useEffect, useState } from "react";
import { encodeSignUpChoice, SIGN_UP_CHOICE_COOKIE, SIGN_UP_CHOICE_MAX_AGE_SECONDS } from "../signup.js";
import { digestCss } from "./styles.js";

/**
 * THE OPT-IN AT SIGN-UP (digest 0.1): one box per digest, UNTICKED, beside
 * the sign-up form — "Email me the Morning summary: …". It writes a
 * short-lived first-party cookie with this browser's time zone (always: it
 * is when "7 AM" is) and the boxes ticked; the page a new account lands on
 * first applies it once and deletes it (`digests.applySignUpChoice`). An
 * account made with nothing ticked gets nothing until the person chooses it
 * in their preferences.
 */

export interface SignUpEmailChoiceProps {
  readonly digests: readonly { readonly key: string; readonly title: string; readonly description: string }[];
  /** Default "aig_email_choice". */
  readonly cookieName?: string;
}

function zone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

function writeCookie(name: string, digests: readonly string[]): void {
  const secure = typeof location !== "undefined" && location.protocol === "https:" ? "; secure" : "";
  document.cookie = `${name}=${encodeSignUpChoice({ timeZone: zone(), digests })}; path=/; max-age=${SIGN_UP_CHOICE_MAX_AGE_SECONDS}; samesite=lax${secure}`;
}

export function SignUpEmailChoice({ digests, cookieName = SIGN_UP_CHOICE_COOKIE }: SignUpEmailChoiceProps) {
  const [ticked, setTicked] = useState<readonly string[]>([]);

  // The zone is written as soon as the page is open, ticked or not.
  useEffect(() => {
    writeCookie(cookieName, ticked);
  }, [cookieName, ticked]);

  if (digests.length === 0) return null;
  return (
    <div className="aidg">
      <style>{digestCss}</style>
      {digests.map((digest) => {
        const id = `aidg-signup-${digest.key}`;
        return (
          <div key={digest.key} className="aidg-optin">
            <input
              id={id}
              type="checkbox"
              checked={ticked.includes(digest.key)}
              onChange={(event) =>
                setTicked((now) => (event.target.checked ? [...now.filter((key) => key !== digest.key), digest.key] : now.filter((key) => key !== digest.key)))
              }
            />
            <label htmlFor={id}>
              Email me the {digest.title}: {digest.description} You can stop it any time.
            </label>
          </div>
        );
      })}
    </div>
  );
}
