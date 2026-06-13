export function toJson(value: unknown) {
  return JSON.stringify(value);
}

export function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}
