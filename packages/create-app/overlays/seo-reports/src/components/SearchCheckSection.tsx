"use client";

import { useMemo } from "react";
import { createSearchCheckTransport, SearchCheck } from "__SCOPE__/seo-reports/ui";

/**
 * The search check (Tenancy 2b-4b), the same for a company's /app/website and
 * this site's own /admin/seo: how search engines and AI assistants read the
 * site, as a list of things to fix, the past checks, and Check now — the
 * package's screen, talking to the routes it is given, so a fix reaches this
 * project with `pnpm update`.
 */
export function SearchCheckSection(props: { readonly baseUrl: string }) {
  const transport = useMemo(() => createSearchCheckTransport({ baseUrl: props.baseUrl }), [props.baseUrl]);
  return <SearchCheck transport={transport} />;
}
