"use client";

import { useMemo } from "react";
import { AiMentions, createAiMentionsTransport } from "__SCOPE__/aeo/ui";

/**
 * AI mentions (Tenancy 2b-4b), the same for a company's /app/website and this
 * site's own /admin/aeo: the questions customers ask an AI assistant, whether
 * the answer names the business, the quoted words, the sources and the trend —
 * the package's screen, talking to the routes it is given.
 */
export function AiMentionsSection(props: { readonly baseUrl: string }) {
  const transport = useMemo(() => createAiMentionsTransport({ baseUrl: props.baseUrl }), [props.baseUrl]);
  return <AiMentions transport={transport} />;
}
