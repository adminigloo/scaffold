import { redirect } from "next/navigation";

/**
 * /app is the __TENANT_LABEL_LOWER__'s working area (Tenancy 2a): /app/schedule,
 * /app/estimates, /app/invoices, /app/messages … — whichever this project has.
 * Its front door is the dashboard, which lists the parts the person's role
 * opens, so /app itself just goes there.
 */
export default function AppIndexPage(): never {
  redirect("/dashboard");
}
