"use client";

import { useState } from "react";
import { TENANT_ROLE_TEMPLATES } from "__SCOPE__/tenancy";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  Input,
  Notice,
  Select,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "@/components/ui";
import { api } from "@/trpc/client";

/**
 * Outstanding invitations, and the form that creates one.
 *
 * WHY RESEND MINTS A NEW LINK RATHER THAN POSTING THE OLD ONE AGAIN: the
 * database stores only the SHA-256 of an invitation token, so the original link
 * exists in exactly one place — the email that was sent. There is nothing left
 * to re-send. "Resend" therefore rotates the token and pushes the expiry out,
 * which is also the behaviour you want: the common reason to press it is that
 * the first link expired, and the second is that it went somewhere it should
 * not have. A product that could re-send the same string would be one that had
 * kept the credential in plaintext.
 *
 * THE COPY-THE-LINK PANEL IS NOT A CONVENIENCE. With no Resend key the send is
 * recorded as `skipped` and nothing leaves the building, so without the link
 * the whole feature would be untestable on a laptop until somebody found a
 * credential — which is the precise failure this scaffold exists to avoid. The
 * server returns the URL only when the message was NOT accepted by a provider;
 * once mail works, the token goes to the invitee and to nobody else.
 *
 * `canInvite` arrives from the server, already resolved. The browser never
 * re-derives a permission: the same answer the procedure will enforce is the
 * one the UI draws from, so a disabled control and a refused request cannot
 * disagree. Hiding the form is a courtesy — the procedure is the boundary.
 */
export interface PendingInvitationsProps {
  readonly tenantId: string;
  readonly tenantName: string;
  readonly canInvite: boolean;
}

/** Only the two states this list shows. Accepted and revoked ones drop off. */
const STATE_TONE = {
  pending: "accent",
  expired: "warn",
} as const;

export function PendingInvitations({
  tenantId,
  tenantName,
  canInvite,
}: PendingInvitationsProps) {
  const utils = api.useUtils();
  const list = api.invitations.list.useQuery(
    { tenantId },
    // A viewer holds `members.view` and not `members.invite`, so this query
    // would be a guaranteed FORBIDDEN for them — one per page view, in the
    // error log, for a screen that is working exactly as designed.
    { enabled: canInvite },
  );

  const [email, setEmail] = useState("");
  const [roleTemplateKey, setRoleTemplateKey] = useState("member");
  const [link, setLink] = useState<string | null>(null);

  const refresh = async () => {
    await utils.invitations.list.invalidate({ tenantId });
  };

  const send = api.invitations.send.useMutation({
    onSuccess: async (result) => {
      setEmail("");
      setLink(result.link);
      await refresh();
    },
  });
  const resend = api.invitations.resend.useMutation({
    onSuccess: async (result) => {
      setLink(result.link);
      await refresh();
    },
  });
  const revoke = api.invitations.revoke.useMutation({ onSuccess: refresh });

  if (!canInvite) {
    return (
      <Card>
        <CardHeader title="Invitations" />
        <CardBody>
          <Notice tone="info">
            Only people who can invite members can see who has been invited. An
            invitation names somebody who is not in {tenantName} yet, which is
            why it does not travel with the member list.
          </Notice>
        </CardBody>
      </Card>
    );
  }

  const busy = send.isPending || resend.isPending || revoke.isPending;
  const failure = send.error ?? resend.error ?? revoke.error;
  const rows = list.data?.invitations ?? [];

  return (
    <Card>
      <CardHeader
        title="Invitations"
        hint="Pending and expired. Accepted and revoked ones drop off the list."
      />

      <CardBody className="flex flex-col gap-4 border-b border-line">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            setLink(null);
            send.mutate({ tenantId, email, roleTemplateKey });
          }}
        >
          <div className="min-w-56 flex-1">
            <Field label="Email address" htmlFor="invite-email">
              <Input
                id="invite-email"
                type="email"
                required
                autoComplete="off"
                placeholder="colleague@example.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </Field>
          </div>
          <div className="w-44">
            <Field label="Role" htmlFor="invite-role">
              {/* Read from the shipped templates rather than typed out. A role
                  added to TENANT_ROLE_TEMPLATES appears here without an edit,
                  and one removed stops being offerable — a hardcoded option
                  would send a key the server then refuses. */}
              <Select
                id="invite-role"
                value={roleTemplateKey}
                onChange={(event) => setRoleTemplateKey(event.target.value)}
              >
                {TENANT_ROLE_TEMPLATES.map((template) => (
                  <option key={template.key} value={template.key}>
                    {template.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Button type="submit" variant="primary" disabled={busy}>
            {send.isPending ? "Inviting…" : "Send invitation"}
          </Button>
        </form>

        {failure && (
          <Notice tone="danger" role="alert" title="That did not work">
            {failure.message}
          </Notice>
        )}

        {link && (
          <Notice tone="warn" role="status" title="Nothing was emailed">
            {/* Shown only when the server says the message was not accepted by
                a provider. The token is inside this string: it IS the
                credential, which is why it is never rendered beside an
                invitation that was actually delivered. */}
            No mail could be sent, so pass this link on yourself. It is the only
            copy — the database keeps a hash and nothing else.
            <code className="mt-1 block overflow-x-auto rounded-[3px] bg-accent-soft px-1.5 py-1 font-mono text-xs text-accent">
              {link}
            </code>
          </Notice>
        )}
      </CardBody>

      {list.isLoading ? (
        <CardBody>
          <p role="status" className="text-sm text-ink-muted">
            Loading invitations…
          </p>
        </CardBody>
      ) : list.error ? (
        <CardBody>
          <Notice tone="danger" role="alert">
            {list.error.message}
          </Notice>
        </CardBody>
      ) : rows.length === 0 ? (
        <CardBody>
          <EmptyState title="Nobody is waiting on an invitation">
            Invite somebody above. They get a one-time link that expires, and
            they land here as a member of {tenantName} once they use it.
          </EmptyState>
        </CardBody>
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Invited</TH>
              <TH>Role</TH>
              <TH>State</TH>
              <TH>Expires</TH>
              <TH>
                <span className="sr-only">Actions</span>
              </TH>
            </TR>
          </THead>
          <TBody>
            {rows.map((invitation) => (
              <TR key={invitation.id}>
                <TD className="font-medium text-ink">{invitation.email}</TD>
                <TD className="text-ink-muted">{invitation.roleName}</TD>
                <TD>
                  <Badge tone={STATE_TONE[invitation.state]}>{invitation.state}</Badge>
                </TD>
                <TD className="whitespace-nowrap text-ink-muted">
                  {invitation.expiresAt === null
                    ? "Never"
                    : invitation.expiresAt.toISOString().slice(0, 10)}
                </TD>
                <TD>
                  <div className="flex justify-end gap-2">
                    <Button
                      disabled={busy}
                      onClick={() => {
                        setLink(null);
                        resend.mutate({ tenantId, id: invitation.id });
                      }}
                    >
                      Resend
                    </Button>
                    <Button
                      variant="danger"
                      disabled={busy}
                      onClick={() => {
                        setLink(null);
                        revoke.mutate({ tenantId, id: invitation.id });
                      }}
                    >
                      Revoke
                    </Button>
                  </div>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </Card>
  );
}
