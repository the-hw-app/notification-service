import type { Condition, ConditionOperator } from "@notification-service/db/types";

/**
 * Condition evaluation for the dropdown builder.
 *
 * Runs on the **ingest hot path** for every (event × active campaign), so it is
 * deliberately allocation-light and free of any I/O. Rules are ANDed; there are
 * no OR-groups and no user-property rules in v1 — the custom-function escape
 * hatch covers anything this can't express (see DESIGN.md).
 */

/** Read a possibly-dotted path (`order.total`) out of an event's properties. */
export function getPath(source: unknown, path: string): unknown {
  let current = source;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** SQLite-ish loose equality: compare numbers as numbers, everything else as strings. */
function looseEquals(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (actual === null || actual === undefined || expected === null || expected === undefined) {
    return false;
  }
  if (typeof actual === "number" || typeof expected === "number") {
    const a = Number(actual);
    const b = Number(expected);
    return !Number.isNaN(a) && !Number.isNaN(b) && a === b;
  }
  return String(actual) === String(expected);
}

/**
 * Ordering comparison. Numeric when both sides coerce to finite numbers,
 * lexicographic otherwise — which is what makes ISO-8601 timestamps compare
 * correctly without a date type.
 */
function compare(actual: unknown, expected: unknown): number | undefined {
  if (actual === null || actual === undefined || expected === null || expected === undefined) {
    return undefined;
  }
  if (typeof actual === "boolean" || typeof expected === "boolean") return undefined;

  const a = Number(actual);
  const b = Number(expected);
  if (Number.isFinite(a) && Number.isFinite(b)) return a === b ? 0 : a < b ? -1 : 1;

  if (typeof actual === "object" || typeof expected === "object") return undefined;
  const sa = String(actual);
  const sb = String(expected);
  return sa === sb ? 0 : sa < sb ? -1 : 1;
}

function evaluate(operator: ConditionOperator, actual: unknown, expected: unknown): boolean {
  switch (operator) {
    case "exists":
      return actual !== undefined && actual !== null;

    case "=":
      return looseEquals(actual, expected);

    case "!=":
      // An absent property is "not equal" to any concrete value.
      return !looseEquals(actual, expected);

    case ">":
    case "<":
    case ">=":
    case "<=": {
      const ordering = compare(actual, expected);
      if (ordering === undefined) return false;
      if (operator === ">") return ordering > 0;
      if (operator === "<") return ordering < 0;
      if (operator === ">=") return ordering >= 0;
      return ordering <= 0;
    }

    case "contains":
      if (Array.isArray(actual)) return actual.some((item) => looseEquals(item, expected));
      if (typeof actual === "string") return actual.includes(String(expected));
      return false;

    case "in":
      if (!Array.isArray(expected)) return false;
      return expected.some((candidate) => looseEquals(actual, candidate));

    default: {
      // Exhaustiveness: an unknown operator must never silently match.
      const _never: never = operator;
      void _never;
      return false;
    }
  }
}

/** True when every rule holds. An empty rule list matches everything. */
export function matchesConditions(
  conditions: readonly Condition[],
  properties: Record<string, unknown>,
): boolean {
  for (const condition of conditions) {
    const actual = getPath(properties, condition.property);
    if (!evaluate(condition.operator, actual, condition.value)) return false;
  }
  return true;
}
