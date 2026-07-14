import type { Condition } from "@notification-service/db/types";
import { describe, expect, it } from "vitest";

import { getPath, matchesConditions } from "./conditions.js";

const props = {
  plan: "pro",
  total: 42,
  active: true,
  tags: ["beta", "vip"],
  createdAt: "2026-07-10T12:00:00Z",
  order: { total: 99 },
  nothing: null,
};

const match = (...conditions: Condition[]) => matchesConditions(conditions, props);

describe("getPath", () => {
  it("reads dotted paths", () => {
    expect(getPath(props, "order.total")).toBe(99);
  });

  it("returns undefined rather than throwing when it walks off the object", () => {
    expect(getPath(props, "order.missing.deep")).toBeUndefined();
    expect(getPath(props, "total.nope")).toBeUndefined();
  });
});

describe("matchesConditions", () => {
  it("matches everything when there are no rules", () => {
    expect(match()).toBe(true);
  });

  it("ANDs every rule", () => {
    expect(match({ property: "plan", operator: "=", value: "pro" })).toBe(true);
    expect(
      match(
        { property: "plan", operator: "=", value: "pro" },
        { property: "total", operator: ">", value: 100 },
      ),
    ).toBe(false);
  });

  it("compares numbers numerically, not lexicographically", () => {
    // The bug this guards: "9" > "42" as strings.
    expect(match({ property: "total", operator: ">", value: 9 })).toBe(true);
    expect(match({ property: "total", operator: "<", value: 9 })).toBe(false);
  });

  it("coerces across the string/number boundary for equality", () => {
    // Event properties arrive as JSON; a rule authored in the UI is a string.
    expect(match({ property: "total", operator: "=", value: "42" })).toBe(true);
  });

  it("compares ISO timestamps lexicographically", () => {
    expect(match({ property: "createdAt", operator: ">", value: "2026-01-01" })).toBe(true);
    expect(match({ property: "createdAt", operator: "<", value: "2026-01-01" })).toBe(false);
  });

  it("treats an absent property as not-equal, and never as a match", () => {
    expect(match({ property: "missing", operator: "!=", value: "x" })).toBe(true);
    expect(match({ property: "missing", operator: "=", value: "x" })).toBe(false);
    expect(match({ property: "missing", operator: ">", value: 0 })).toBe(false);
  });

  it("handles exists against null", () => {
    expect(match({ property: "plan", operator: "exists" })).toBe(true);
    expect(match({ property: "missing", operator: "exists" })).toBe(false);
    // A property explicitly set to null does not "exist".
    expect(match({ property: "nothing", operator: "exists" })).toBe(false);
  });

  it("supports contains for both strings and arrays", () => {
    expect(match({ property: "plan", operator: "contains", value: "r" })).toBe(true);
    expect(match({ property: "tags", operator: "contains", value: "vip" })).toBe(true);
    expect(match({ property: "tags", operator: "contains", value: "nope" })).toBe(false);
    expect(match({ property: "total", operator: "contains", value: "4" })).toBe(false);
  });

  it("supports in, and rejects a non-array value", () => {
    expect(match({ property: "plan", operator: "in", value: ["free", "pro"] })).toBe(true);
    expect(match({ property: "plan", operator: "in", value: ["free"] })).toBe(false);
    expect(match({ property: "total", operator: "in", value: ["42"] })).toBe(true);
    expect(match({ property: "plan", operator: "in", value: "pro" })).toBe(false);
  });

  it("does not order-compare booleans", () => {
    expect(match({ property: "active", operator: ">", value: 0 })).toBe(false);
    expect(match({ property: "active", operator: "=", value: true })).toBe(true);
  });
});
