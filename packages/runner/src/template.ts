export function renderPromptTemplate(template: string, values: Record<string, string>) {
  return template.replaceAll(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, key: string) => values[key] ?? "");
}

export function prettyJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}
