export type TemplateVars = Record<string, string | number | undefined | null>;

const TOKEN = /\{\{\s*([\w.-]+)\s*\}\}/g;

export function render(template: string, vars: TemplateVars): string {
  return template.replace(TOKEN, (_, key: string) => {
    const value = vars[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

/**
 * Values interpolated into `render()` must not contain literal `{{key}}` substrings,
 * or those tokens would be substituted in a second conceptual pass. Break `{{` so
 * the simple regex no longer matches.
 */
export function escapeTemplateValue(s: string): string {
  return s.replace(/\{\{/g, '{ {');
}
