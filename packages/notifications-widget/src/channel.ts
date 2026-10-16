/**
 * TWO TABS (Tenancy 2b-1, section 5). Someone reads an alert in one tab; the
 * badge in their other tab should drop at once, not a minute later. After a
 * mark, a tab posts `{ unread }` on a BroadcastChannel named
 * `ainw:{baseUrl}` (one per company: the base URL names it); every other bell
 * and inbox on that channel sets its count and reloads an open list.
 *
 * No BroadcastChannel (an old browser, the server render): nothing is
 * posted, and the poll covers it.
 */

export interface AlertsChannelMessage {
  readonly unread: number;
}

export interface AlertsChannel {
  post(message: AlertsChannelMessage): void;
  close(): void;
}

/** The channel's name for a mount: one per company. */
export function channelName(baseUrl: string | undefined): string {
  return `ainw:${baseUrl ?? "custom"}`;
}

type ChannelCtor = new (name: string) => {
  postMessage(message: unknown): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
};

/** Open the channel; `onMessage` hears the OTHER instances' posts (a channel never hears its own). */
export function openAlertsChannel(name: string, onMessage: (message: AlertsChannelMessage) => void): AlertsChannel {
  const Ctor = (globalThis as { BroadcastChannel?: ChannelCtor }).BroadcastChannel;
  if (typeof Ctor !== "function") return { post: () => {}, close: () => {} };
  let channel: InstanceType<ChannelCtor> | null = null;
  try {
    channel = new Ctor(name);
    channel.onmessage = (event) => {
      const data = event?.data as { unread?: unknown } | null;
      if (data && typeof data.unread === "number" && Number.isFinite(data.unread)) onMessage({ unread: Math.max(0, Math.trunc(data.unread)) });
    };
  } catch {
    channel = null;
  }
  return {
    post: (message) => {
      try {
        channel?.postMessage({ unread: message.unread });
      } catch {
        /* a closed channel: the poll covers it */
      }
    },
    close: () => {
      try {
        if (channel) channel.onmessage = null;
        channel?.close();
      } catch {
        /* already closed */
      }
      channel = null;
    },
  };
}
