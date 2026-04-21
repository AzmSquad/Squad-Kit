export type TemplateVars = Record<string, string | number | undefined | null>;

const TOKEN = /\{\{\s*([\w.-]+)\s*\}\}/g;

export function render(template: string, vars: TemplateVars): string {
  return template.replace(TOKEN, (_, key: string) => {
    const value = vars[key];
    return value === undefined || value === null ? '' : String(value);
  });
}
