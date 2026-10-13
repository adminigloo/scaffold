import { redirect } from "next/navigation";

/**
 * The old members page. It lives at /settings/team now (Tenancy 1).
 *
 * KEPT AS A REDIRECT, not deleted, because the address is out in the world:
 * bookmarks, and every invitation email sent by a 0.21 project said "see who's
 * in it at /members". A 404 there would read as "the team is gone".
 *
 * The page it replaces rendered the roster itself and its "suspended
 * membership" copy described a state the new membership gate handles in one
 * place (<CompanyGate> shows the suspended screen). The team page renders the
 * package's <TeamManager>, so invite, resend, withdraw, change a role, remove,
 * leave and hand over ownership all reach this project by `npm update`.
 */
export default function MembersPage(): never {
  redirect("/settings/team");
}
