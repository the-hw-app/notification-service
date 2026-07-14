import { getPath } from "./conditions.js";

/**
 * `{{event.x}}` / `{{user.y}}` template interpolation.
 *
 * Deliberately not a general template language: only these two roots resolve,
 * there is no logic, and an unresolvable placeholder renders as the empty
 * string rather than throwing or leaking the raw `{{…}}` to a user's lock
 * screen. Values are stringified with `String()`; objects render as JSON so a
 * misaddressed placeholder is visibly wrong rather than `[object Object]`.
 */

const PLACEHOLDER = /\{\{\s*(event|user)\.([\w.]+)\s*\}\}/g;

export interface InterpolationScope {
  event: Record<string, unknown>;
  user: Record<string, unknown>;
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function interpolate(template: string, scope: InterpolationScope): string {
  return template.replace(PLACEHOLDER, (_match, root: "event" | "user", path: string) =>
    stringify(getPath(scope[root], path)),
  );
}

/** Recursively interpolate every string in a JSON-ish structure. */
export function interpolateDeep<T>(value: T, scope: InterpolationScope): T {
  if (typeof value === "string") return interpolate(value, scope) as T;
  if (Array.isArray(value)) return value.map((item) => interpolateDeep(item, scope)) as T;
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = interpolateDeep(item, scope);
    }
    return result as T;
  }
  return value;
}
