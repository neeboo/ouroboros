import { fail } from "./args";

export function parseObject(raw: string) {
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("expected a JSON object");
  }
  return value as Record<string, unknown>;
}

export function parseArray(raw: string) {
  const value = JSON.parse(raw);
  if (!Array.isArray(value)) {
    fail("expected a JSON array");
  }
  return value as string[];
}

export function printJson(value: unknown) {
  console.log(JSON.stringify(value));
}
