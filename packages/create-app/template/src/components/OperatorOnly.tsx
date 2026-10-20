import type { ReactNode } from "react";
import { operatorView } from "@/server/operator";

/**
 * Children only for the site's operator (src/server/operator.ts): the
 * technical half of a message — which setting, which file, the link to
 * /setup. Everyone else reads the plain half, written outside this.
 *
 *   <Notice title="Sign-in isn't switched on yet">
 *     <OperatorOnly>Add CLERK_SECRET_KEY to .env.local …</OperatorOnly>
 *   </Notice>
 */
export async function OperatorOnly({ children, fallback = null }: { readonly children: ReactNode; readonly fallback?: ReactNode }) {
  return (await operatorView()) ? <>{children}</> : <>{fallback}</>;
}
