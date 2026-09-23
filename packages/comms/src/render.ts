/**
 * Template rendering — pure. `{{variable}}` placeholders are replaced from a
 * plain map; an unknown placeholder renders as empty rather than leaving the
 * braces in a message a customer reads. Whitespace inside the braces is
 * tolerated (`{{ name }}`).
 */
export type TemplateVars = Record<string, string | number | null | undefined>;

/**
 * Own properties only. A plain `vars[key]` walks the prototype chain, so a
 * template containing `{{constructor}}` or `{{toString}}` rendered
 * "function Object() { [native code] }" into the customer's message.
 */
function lookup(vars: TemplateVars, key: string): string | number | null | undefined {
  return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : undefined;
}

export function renderTemplate(template: string, vars: TemplateVars): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key: string) => {
    const value = lookup(vars, key);
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

/**
 * The placeholders across `templates` that `vars` has no value for — the ones
 * that will render blank. Blanking stays the rule (a customer never sees
 * braces); this only makes the gap visible in the delivery log.
 */
export function missingVariables(
  templates: ReadonlyArray<string | null | undefined>,
  vars: TemplateVars,
): string[] {
  const missing = new Set<string>();
  for (const template of templates) {
    if (!template) continue;
    for (const key of templateVariables(template)) {
      const value = lookup(vars, key);
      if (value === null || value === undefined) missing.add(key);
    }
  }
  return [...missing];
}
