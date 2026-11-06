import type { DraftImage, Platform } from "./types.js";
import type { QueuePostView } from "./view.js";

/**
 * WHAT THE POSTS HANDLER ANSWERS (social 0.1), as plain JSON shapes: the
 * screens (./ui) read these, and so can anything else that drives the queue
 * (a posting session in a browser, a script). No Dates, no class instances.
 */

/** GET v1/admin/posts: the queue as the page shows it. */
/** One of the app's looks a post's pictures can wear (social 0.6): its key in the card assets, and what to call it. */
export interface LookOption {
  readonly key: string;
  readonly name: string;
}

/**
 * THE LOOKS A POST CAN WEAR, AS THE APP OFFERS THEM (social 0.7): a list to
 * pick from (the backgrounds, say) and, if the app has one, a switch that
 * adds something over any of them (confetti, say). A look's key is its
 * option's, with the switch's suffix when it's on (../look-choices.ts).
 */
export interface LookChoices {
  /** What the list is called: "Background". */
  readonly label: string;
  readonly options: readonly LookOption[];
  /**
   * The switch, if any: the suffix it adds to a look's key, its entry's words
   * each way (the last entry of the dropdown since 0.7.2), and (0.7.2) what it
   * adds in a word or two ("confetti"): the chosen option then reads "Blue +
   * confetti", and the entry sits under that name.
   */
  readonly toggle?: { readonly suffix: string; readonly turnOn: string; readonly turnOff: string; readonly label?: string };
}

export interface QueueWire {
  /** Today in the business's own time zone (YYYY-MM-DD): what "Today" means on the page. */
  readonly today: string;
  /** The looks a post can be switched to (social 0.6; as two choices since 0.7). Left out: no switching. */
  readonly looks?: LookChoices;
  readonly sections: {
    readonly today: readonly QueuePostView[];
    readonly earlier: readonly QueuePostView[];
    readonly ready: readonly QueuePostView[];
    readonly history: readonly QueuePostView[];
    /** Earlier days' posts that went stale with nothing posted (social 0.2). */
    readonly expired: readonly QueuePostView[];
  };
}

/** POST v1/admin/compose: what a person typed for a post of their own. */
export interface ComposeBody {
  /** The facts, in a sentence or two, numbers and all: the only numbers the AI may use. */
  readonly facts: string;
  /** The page it points to; empty for the app's default. */
  readonly link?: string;
  /** Hashtags as typed ("#bakery new-menu"): five at most, code's, never the AI's. */
  readonly hashtags?: string;
}

/** What composing did: drafts written, and drafts that stayed as a person left them (a repeat of the same key). */
export interface ComposeWire {
  readonly key: string;
  readonly written: number;
  readonly kept: number;
  /** Why the AI's words weren't used, when they weren't (the first draft's note). */
  readonly note: string | null;
}

/** One approved post, with everything a person (or an agent in their browser) needs to post it by hand. */
export interface PostingSessionPost {
  readonly id: string;
  readonly key: string;
  readonly kind: string;
  readonly author: string;
  readonly day: string;
  readonly platform: Platform;
  readonly platformName: string;
  /** Exactly what to paste. */
  readonly text: string;
  readonly hook: string;
  /** The images to attach, in order, with their alt text. */
  readonly images: readonly DraftImage[];
  /** What to post as the first reply (X's and LinkedIn's link goes there). */
  readonly firstComment: string | null;
  readonly linkUrl: string | null;
  /** The platform's composer with the text filled in, where there is one to trust; null: paste by hand. */
  readonly composeUrl: string | null;
}

/** GET v1/admin/approved: the posting session's list, and how to mark each one posted. */
export interface PostingSessionWire {
  readonly posts: readonly PostingSessionPost[];
  readonly markPosted: {
    readonly method: "POST";
    /** With the post's id in place of {id}. */
    readonly url: string;
    readonly body: { readonly url: string };
  };
}

/** One sample card as the formats screen shows it: the image and a label under it. */
export interface CardFormatImage extends DraftImage {
  /** "2 of 3 · cover · 4:5 · 1080×1350". */
  readonly label: string;
}

/** GET v1/admin/card-formats: every card format, as samples in the business's own brand. */
export interface CardFormatSet {
  readonly key: string;
  readonly title: string;
  readonly about: string;
  readonly images: readonly CardFormatImage[];
}

/** Every refusal: a code and a sentence for the person. */
export interface ErrorWire {
  readonly error: { readonly code: string; readonly message: string };
}
