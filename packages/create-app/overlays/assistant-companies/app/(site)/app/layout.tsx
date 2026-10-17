import type { ReactNode } from "react";
import { AssistantLauncherSlot } from "@/components/AssistantLauncherSlot";

/**
 * Every page of a company's area (/app/…) gets the assistant's button
 * (Tenancy 2b-3): it opens the chat for the company the person is working in.
 * The slot is generated (src/components/AssistantLauncherSlot.tsx): the
 * launcher with --ai, nothing without. This layout gates nothing — each page
 * still checks its own permission (CompanyGate), and the assistant's routes
 * check theirs on every request.
 */
export default function CompanyAreaLayout({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <AssistantLauncherSlot />
    </>
  );
}
