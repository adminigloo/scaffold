import { createRequester, isObject, listOf, num, str, strOrNull, stringList, type Result, type TransportOptions } from "./http.js";
import type {
  ActiveBody,
  CommsStatusWire,
  MessageStatus,
  MessageWire,
  MessagesWire,
  RunDueWire,
  TemplateBody,
  TemplateWire,
  TemplatesWire,
} from "./types.js";

/**
 * The Messages console's transport: one method per route of
 * @adminigloo/comms's `createCommsAdminHandlers` (contract 9.5). A host that
 * backs the console with something else (a server action, tRPC) passes its
 * own object of this shape as `transport`.
 */
export interface CommsTransport {
  status(): Promise<Result<CommsStatusWire>>;
  templates(): Promise<Result<TemplatesWire>>;
  saveTemplate(key: string, body: TemplateBody): Promise<Result<{ template: TemplateWire }>>;
  setActive(key: string, body: ActiveBody): Promise<Result<{ template: TemplateWire }>>;
  messages(q?: { limit?: number }): Promise<Result<MessagesWire>>;
  runDue(): Promise<Result<RunDueWire>>;
}

const MESSAGE_STATUSES: readonly MessageStatus[] = ["sent", "skipped", "failed", "cancelled", "expired"];

export function parseTemplate(raw: unknown): TemplateWire | null {
  if (!isObject(raw) || typeof raw.key !== "string" || typeof raw.body !== "string") return null;
  return {
    key: raw.key,
    channel: raw.channel === "sms" ? "sms" : "email",
    subject: strOrNull(raw.subject),
    body: raw.body,
    active: raw.active !== false,
    updatedAt: str(raw.updatedAt),
    variables: stringList(raw.variables),
  };
}

export function parseMessage(raw: unknown): MessageWire | null {
  if (!isObject(raw) || typeof raw.id !== "string") return null;
  const status = MESSAGE_STATUSES.includes(raw.status as MessageStatus) ? (raw.status as MessageStatus) : "failed";
  return {
    id: raw.id,
    at: str(raw.at),
    channel: raw.channel === "sms" ? "sms" : "email",
    to: str(raw.to),
    templateKey: strOrNull(raw.templateKey),
    subject: strOrNull(raw.subject),
    status,
    note: strOrNull(raw.note),
    blanks: stringList(raw.blanks),
    fromName: strOrNull(raw.fromName),
    replyTo: strOrNull(raw.replyTo),
  };
}

function parseStatus(raw: unknown): CommsStatusWire | null {
  if (!isObject(raw) || typeof raw.emails !== "boolean") return null;
  const scheduled = isObject(raw.scheduled) ? raw.scheduled : {};
  return {
    emails: raw.emails,
    emailsOffReason: strOrNull(raw.emailsOffReason),
    fromName: strOrNull(raw.fromName),
    replyTo: strOrNull(raw.replyTo),
    // `behind` is 0 from a server that predates it, never NaN.
    scheduled: { pending: num(scheduled.pending), behind: num(scheduled.behind), late: num(scheduled.late) },
  };
}

function parseOneTemplate(raw: unknown): { template: TemplateWire } | null {
  const template = isObject(raw) ? parseTemplate(raw.template) : null;
  return template ? { template } : null;
}

function parseRunDue(raw: unknown): RunDueWire | null {
  if (!isObject(raw) || typeof raw.sent !== "number") return null;
  return {
    sent: num(raw.sent),
    skipped: num(raw.skipped),
    failed: num(raw.failed),
    retrying: num(raw.retrying),
    cancelled: num(raw.cancelled),
    expired: num(raw.expired),
    stoppedEarly: raw.stoppedEarly === true,
  };
}

const segment = (value: string) => encodeURIComponent(value);

/** The transport over HTTP, at `baseUrl` (the handler's mount). Never throws. */
export function createCommsClient(options: TransportOptions): CommsTransport {
  const http = createRequester(options);
  return {
    status: () => http.get("/v1/admin/status", parseStatus),
    templates: () =>
      http.get("/v1/admin/templates", (raw) => (isObject(raw) && Array.isArray(raw.templates) ? { templates: listOf(raw.templates, parseTemplate) } : null)),
    saveTemplate: (key, body) => http.post(`/v1/admin/templates/${segment(key)}`, body, parseOneTemplate),
    setActive: (key, body) => http.post(`/v1/admin/templates/${segment(key)}/active`, body, parseOneTemplate),
    messages: (q = {}) =>
      http.get(`/v1/admin/messages${q.limit !== undefined ? `?limit=${encodeURIComponent(String(q.limit))}` : ""}`, (raw) =>
        isObject(raw) && Array.isArray(raw.messages) ? { messages: listOf(raw.messages, parseMessage) } : null,
      ),
    runDue: () => http.post("/v1/admin/run-due", {}, parseRunDue),
  };
}
