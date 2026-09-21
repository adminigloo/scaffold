/**
 * Template rendering — pure. `{{variable}}` placeholders are replaced from a
 * plain map; an unknown placeholder renders as empty rather than leaving the
 * braces in a message a customer reads. Whitespace inside the braces is
 * tolerated (`{{ name }}`).
 */
export type TemplateVars = Record<string, string | number | null | undefined>;

export function renderTemplate(template: string, vars: TemplateVars): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key: string) => {
    const value = vars[key];
    return value === null || value === undefined ? "" : String(value);
  });
}

/** The distinct placeholders a template references, e.g. for a preview form. */
export function templateVariables(template: string): string[] {
  const found = new Set<string>();
  for (const match of template.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) {
    if (match[1]) found.add(match[1]);
  }
  return [...found];
}
