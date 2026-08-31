import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { auditEntry } from "__SCOPE__/observability";
import { auditLog } from "__SCOPE__/observability/schema";
import { principalRole, roleTemplate } from "__SCOPE__/permissions/schema";
import { canManageTemplateKey, TENANT_ROLE_TEMPLATES } from "__SCOPE__/tenancy";
import { tenants } from "__SCOPE__/tenancy/schema";
import { db } from "@/db";
import { auditRegistry } from "../audit";
import { INVITATION_EXPIRY_HOURS, invitations, invitationUrl } from "../invitations";
import { sendInvitationEmail } from "../invitation-mail";
import { requestContext } from "../request-context";
import { createTRPCRouter, protectedProcedure, requireTenant } from "../trpc";

/**
 * Adding a second person to one __TENANT_LABEL_LOWER__.
 *
 * THE RUNG IS THE INTERESTING PART OF THIS FILE. Four procedures are
 * `requireTenant("members.invite")` and one — `accept` — is
 * `protectedProcedure`, and the odd one out is not an oversight. Everything
 * tenant-scoped resolves permissions for the tenant named in the input, which
 * requires the caller to already be a member of it. The whole point of
 * accepting an invitation is that you are NOT a member yet: `requireTenant`
 * would deny the invitee at the one moment the feature exists to serve, and it
 * would deny them with "Not a member of tenant …", which is true, unhelpful,
 * and impossible to distinguish from a broken link. So acceptance runs one rung
 * lower — signed in, no tenant, no permission — and the TOKEN is the
 * authorisation. That is the entire security model of the accept path: holding
 * an unguessable one-time secret that was mailed to a specific address.
 *
 * Inviting, by contrast, is a TENANT permission and not a staff one.
 * `members.invite` already exists in @__SCOPE_NAME__/tenancy's fragment and is
 * spread into the tenant catalog, so nothing new was declared. Getting that
 * wrong is silent in both directions: a key declared under "staff" and checked
 * with `requireTenant` matches nothing, the button is invisible to everybody
 * including the owner, and no error is raised anywhere. That has already
 * happened once in this repository, with the catalog keys.
 *
 * WHAT THIS ROUTER OWNS AND WHAT IT DOES NOT. @__SCOPE_NAME__/tenancy owns the
 * rules — hash the token, refuse an expired or revoked or spent one, notice an
 * address that is already a member — because those must not have a second
 * implementation. This router owns the three things that are the application's:
 * who is allowed to ask, what gets written to the audit log, and where the mail
 * goes. It deliberately holds no invitation logic of its own.
 */

/** Every role an invitation may carry, from the shipped templates. */
const ROLE_KEYS: readonly string[] = TENANT_ROLE_TEMPLATES.map((t) => t.key);

const roleTemplateKeyInput = z
  .string()
  .refine((key) => ROLE_KEYS.includes(key), {
    message: `must be one of ${ROLE_KEYS.join(", ")}`,
  });

/**
 * Addresses are lowercased and trimmed by the service before they are stored,
 * against a partial unique index that compares bytes. Zod only decides whether
 * this looks like an address at all — the canonical form is the service's job,
 * and doing it twice is how the two spellings drift apart.
 */
const emailInput = z.string().trim().min(3).max(254).email();

const invitationIdInput = z.object({ id: z.string().min(1) });

function roleNameFor(key: string): string {
  return TENANT_ROLE_TEMPLATES.find((template) => template.key === key)?.name ?? key;
}

/**
 * May this person hand out this role?
 *
 * `members.invite` says you may invite. It does not say you may invite somebody
 * as your equal or your superior, and conflating the two is a complete
 * privilege escalation in one call: an admin who can issue an owner invitation
 * mails it to an address they control, accepts it, and now holds
 * `tenant.transfer` — which the catalog SEALS precisely so that it cannot be
 * granted to one person quietly. The seal on the override path is worth nothing
 * if the invitation path is open.
 *
 * STRICTLY GREATER, from `canManageTemplateKey`, so an admin cannot invite an
 * admin either. Equal ranks are the case that actually bites: two people who
 * can each create the other's replacement turn a disagreement into a race, and
 * nothing in the audit log looks like an escalation because no rank changed.
 *
 * An actor with no role row in this tenant is refused. They can only have
 * reached here through a per-person override granting `members.invite` with no
 * template behind it, and "no rank" must never read as "no restriction" —
 * `canManageTemplateKey` fails closed on an unknown key and this fails closed
 * on a missing one.
 */
async function assertMayGrant(input: {
  actorUserId: string;
  tenantId: string;
  roleTemplateKey: string;
}): Promise<void> {
  const rows = await db
    .select({ key: roleTemplate.key })
    .from(principalRole)
    .innerJoin(roleTemplate, eq(roleTemplate.id, principalRole.templateId))
    .where(
      and(
        eq(principalRole.principalId, input.actorUserId),
        eq(principalRole.scope, "tenant"),
        eq(principalRole.tenantId, input.tenantId),
      ),
    )
    .limit(1);

  const actorKey = rows[0]?.key;
  if (actorKey === undefined) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "You hold no role in this __TENANT_LABEL_LOWER__, so there is no rank " +
        "to compare an invitation against. Ask an owner to assign you one.",
    });
  }

  if (!canManageTemplateKey(actorKey, input.roleTemplateKey)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        `A ${roleNameFor(actorKey)} cannot invite somebody as ` +
        `${roleNameFor(input.roleTemplateKey)}. An invitation may only carry a ` +
        `role below your own.`,
    });
  }
}

/** The tenant behind `ctx.tenantId`. It exists — the rung proved membership. */
async function tenantNameFor(tenantId: string): Promise<string> {
  const row = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  // A membership row can outlive a soft-deleted tenant, so the fallback is not
  // decoration. Rendering "your organisation" beats rendering "undefined".
  return row?.name ?? "your __TENANT_LABEL_LOWER__";
}

/**
 * One invitation of this tenant's, by id.
 *
 * THE SERVICE'S `revoke(id, byUserId)` TAKES NO TENANT, so an id alone would be
 * enough to revoke a stranger's invitation from inside your own
 * __TENANT_LABEL_LOWER__ — a textbook insecure direct object reference, and one
 * the procedure ladder cannot catch, because the caller genuinely does hold
 * `members.invite` somewhere. Resolving the id through `listForTenant` first is
 * what binds it to `ctx.tenantId`, which is the value the rung actually
 * authorised. Anything not in that list reports as NOT_FOUND, which is also the
 * honest answer: it is not found in the __TENANT_LABEL_LOWER__ you asked about.
 */
async function ownInvitation(tenantId: string, id: string) {
  const found = (await invitations.listForTenant(tenantId)).find(
    (invitation) => invitation.id === id,
  );
  if (found === undefined) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "That invitation is not open in this __TENANT_LABEL_LOWER__.",
    });
  }
  return found;
}

/** What `send` and `resend` both return, and the one place the link is decided. */
interface Issued {
  readonly id: string;
  readonly email: string;
  readonly roleName: string;
  readonly expiresAt: Date | null;
  readonly delivery: "sent" | "skipped" | "failed";
  /**
   * The invitation URL, or null once a provider has accepted the message.
   *
   * THE TOKEN IS IN THIS STRING. Returning it routinely would put a bearer
   * credential for somebody else's account in the inviter's browser, their
   * history and any log that records a response body — for no benefit, because
   * the invitee already has it in their inbox. Returning it when the mail did
   * NOT go out is the opposite trade: without it the feature is unusable on a
   * laptop with no Resend key, which is the state every generated project
   * starts in and the exact scenario this scaffold refuses to break.
   */
  readonly link: string | null;
}

/** Mint the URL, post it, write the audit row. Shared by send and resend. */
async function issue(input: {
  actorUserId: string;
  actorEmail: string | null;
  tenantId: string;
  email: string;
  roleTemplateKey: string;
}): Promise<Issued> {
  const tenantName = await tenantNameFor(input.tenantId);

  // The one moment the plaintext token exists. It is returned once, never
  // stored, and from here it goes into exactly two places: the mail body and —
  // only when the mail could not be sent — the response.
  const invitation = await invitations.send({
    tenantId: input.tenantId,
    email: input.email,
    roleTemplateKey: input.roleTemplateKey,
    invitedByUserId: input.actorUserId,
    expiresInHours: INVITATION_EXPIRY_HOURS,
  });

  const url = invitationUrl(invitation.token);
  const roleName = roleNameFor(input.roleTemplateKey);

  const delivery = await sendInvitationEmail({
    to: input.email,
    tenantId: input.tenantId,
    tenantName,
    invitedBy: input.actorEmail,
    roleName,
    url,
    expiresAt: invitation.expiresAt,
    invitationId: invitation.id,
  });

  await db.insert(auditLog).values(
    auditEntry(auditRegistry, {
      action: "invitation.sent",
      actor: { userId: input.actorUserId },
      scope: "tenant",
      tenantId: input.tenantId,
      resourceType: "tenant_invitation",
      resourceId: invitation.id,
      request: await requestContext(),
      // The address and the role, never the token or the URL. `metadata` is
      // jsonb in the one table deliberately kept longer than everything else;
      // a credential written in here outlives the credential, the incident and
      // the employee.
      metadata: {
        email: input.email,
        roleTemplateKey: input.roleTemplateKey,
        delivery: delivery.status,
      },
    }),
  );

  return {
    id: invitation.id,
    email: input.email,
    roleName,
    expiresAt: invitation.expiresAt,
    delivery: delivery.status,
    link: delivery.delivered ? null : url,
  };
}

export const invitationsRouter = createTRPCRouter({
  /**
   * Invitations that are still worth acting on.
   *
   * Pending and expired only. An accepted one is a member now and belongs in
   * the roster; a revoked one is a decision somebody already took, and leaving
   * both in the list turns a short actionable table into an event log with two
   * buttons that do nothing.
   *
   * Gated on `members.invite` rather than `members.view`, which is the tighter
   * of the two and the right one: an invitation is the email address of a
   * person who is NOT in the __TENANT_LABEL_LOWER__, so showing it to every
   * viewer discloses somebody's address to people who cannot act on it.
   */
  list: requireTenant("members.invite")
    .meta({ scope: "tenant" })
    .query(async ({ ctx }) => {
      const summaries = await invitations.listForTenant(ctx.tenantId);

      // flatMap rather than filter+map, because a filter does not narrow the
      // element type: the client renders a tone per state, and without the
      // narrowing it would have to handle two states this list never contains.
      const open = summaries.flatMap((invitation) =>
        invitation.state === "pending" || invitation.state === "expired"
          ? [
              {
                id: invitation.id,
                email: invitation.email,
                roleTemplateKey: invitation.roleTemplateKey,
                roleName: roleNameFor(invitation.roleTemplateKey),
                state: invitation.state,
                expiresAt: invitation.expiresAt,
                createdAt: invitation.createdAt,
              },
            ]
          : [],
      );

      return { invitations: open };
    }),

  /** Invite one address, at one role. */
  send: requireTenant("members.invite")
    .meta({ scope: "tenant" })
    .input(z.object({ email: emailInput, roleTemplateKey: roleTemplateKeyInput }))
    .mutation(async ({ ctx, input }): Promise<Issued> => {
      await assertMayGrant({
        actorUserId: ctx.principal.userId,
        tenantId: ctx.tenantId,
        roleTemplateKey: input.roleTemplateKey,
      });

      return issue({
        actorUserId: ctx.principal.userId,
        actorEmail: ctx.principal.email,
        tenantId: ctx.tenantId,
        email: input.email,
        roleTemplateKey: input.roleTemplateKey,
      });
    }),

  /**
   * Send it again — which mints a NEW link, because there is no old one left.
   *
   * Only the SHA-256 of a token is stored, so the string that went out exists
   * in exactly one place: the mail. "Resend the same link" is not something
   * this system can do, and that is the property that makes a database dump
   * useless to an attacker. What it does instead is exactly what the schema's
   * partial unique index was designed for — re-issuing rotates the hash and
   * pushes the expiry out on the SAME row, so pressing this twice does not
   * leave two open invitations racing for one address.
   *
   * The rank guard runs again rather than being inherited from the original
   * send. The person pressing this may not be the person who sent it, and a
   * demotion between the two is exactly when it matters.
   */
  resend: requireTenant("members.invite")
    .meta({ scope: "tenant" })
    .input(invitationIdInput)
    .mutation(async ({ ctx, input }): Promise<Issued> => {
      const existing = await ownInvitation(ctx.tenantId, input.id);

      await assertMayGrant({
        actorUserId: ctx.principal.userId,
        tenantId: ctx.tenantId,
        roleTemplateKey: existing.roleTemplateKey,
      });

      return issue({
        actorUserId: ctx.principal.userId,
        actorEmail: ctx.principal.email,
        tenantId: ctx.tenantId,
        email: existing.email,
        roleTemplateKey: existing.roleTemplateKey,
      });
    }),

  /** Withdraw one, before anybody uses it. */
  revoke: requireTenant("members.invite")
    .meta({ scope: "tenant" })
    .input(invitationIdInput)
    .mutation(async ({ ctx, input }) => {
      const existing = await ownInvitation(ctx.tenantId, input.id);

      await invitations.revoke(input.id, ctx.principal.userId);

      await db.insert(auditLog).values(
        auditEntry(auditRegistry, {
          action: "invitation.revoked",
          actor: ctx.principal,
          scope: "tenant",
          tenantId: ctx.tenantId,
          resourceType: "tenant_invitation",
          resourceId: input.id,
          request: await requestContext(),
          metadata: {
            email: existing.email,
            roleTemplateKey: existing.roleTemplateKey,
            // What it was when it was withdrawn. Revoking an already-expired
            // invitation is a different act from revoking a live one, and the
            // row is the only place that distinction survives.
            previousState: existing.state,
          },
        }),
      );

      return { id: input.id };
    }),

  /**
   * Redeem a token.
   *
   * `protectedProcedure`, for the reason at the top of this file: the caller is
   * by definition not a member yet. Signed in is the floor, and it is a real
   * one — acceptance has to attach the membership to an account, and an
   * anonymous accept would have nothing to attach it to.
   *
   * IT RETURNS AN OUTCOME AND DOES NOT THROW. Six things can happen here and
   * five of them are not errors: the link expired, somebody withdrew it, you
   * are already in, it was meant for a different address, or we do not
   * recognise it. Each renders as its own screen with its own next step. A
   * thrown TRPCError would collapse all five into one red box, and the invitee
   * — the person in this whole feature with the least context and the least
   * patience — would be told only that something went wrong.
   *
   * THE UNION IS RE-MAPPED HERE RATHER THAN RETURNED RAW. What the service
   * knows and what the invitee may be told are different sets. The invited
   * address, the inviter's identity and the invitation's id are all in the
   * service's result and none of them cross this line: whoever is holding this
   * token may not be the person it was sent to, and a refusal that names the
   * intended recipient hands a stranger a colleague's email address. The
   * unrecognised case is reported as `unknown` and says nothing about whether a
   * token like it ever existed.
   *
   * The `default` arm is deliberate rather than an unhandled case. A future
   * outcome added by the package resolves to "this link cannot be used", which
   * is the only safe reading of a result this build does not understand.
   */
  accept: protectedProcedure
    .meta({ scope: "authenticated" })
    .input(z.object({ token: z.string().min(1).max(512) }))
    .mutation(async ({ ctx, input }) => {
      const result = await invitations.accept(input.token, ctx.principal.userId);

      switch (result.status) {
        case "accepted": {
          await db.insert(auditLog).values(
            auditEntry(auditRegistry, {
              action: "invitation.accepted",
              // The INVITEE is the actor, because they are who acted. Who
              // authorised the access is a separate fact and it is already on
              // the `invitation.sent` row, which names the same
              // __TENANT_LABEL_LOWER__.
              actor: ctx.principal,
              scope: "tenant",
              tenantId: result.tenantId,
              // The tenant, not the invitation: the durable fact is that this
              // person is now inside it, and the invitation row is about to
              // stop being interesting.
              resourceType: "tenant",
              resourceId: result.tenantId,
              request: await requestContext(),
              metadata: { email: ctx.principal.email },
            }),
          );

          return {
            status: "accepted",
            tenantName: await tenantNameFor(result.tenantId),
          } as const;
        }

        case "already-a-member":
          return {
            status: "already-a-member",
            tenantName: await tenantNameFor(result.tenantId),
          } as const;

        case "expired":
          return { status: "expired" } as const;

        case "revoked":
          return { status: "revoked" } as const;

        case "wrong-email":
          return { status: "wrong-email" } as const;

        default:
          return { status: "unknown" } as const;
      }
    }),
});
