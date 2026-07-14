import { describe, expect, it } from "vitest";

import { interpolate, interpolateDeep } from "./interpolate.js";

const scope = {
  event: { product: "Widget", price: 9.99, meta: { sku: "W-1" } },
  user: { firstName: "Ada", plan: "pro" },
};

describe("interpolate", () => {
  it("resolves both roots", () => {
    expect(interpolate("Hi {{user.firstName}}, {{event.product}} is back", scope)).toBe(
      "Hi Ada, Widget is back",
    );
  });

  it("tolerates whitespace inside the braces", () => {
    expect(interpolate("{{ user.firstName }}", scope)).toBe("Ada");
  });

  it("resolves dotted paths and stringifies numbers", () => {
    expect(interpolate("{{event.meta.sku}} @ {{event.price}}", scope)).toBe("W-1 @ 9.99");
  });

  it("renders a missing placeholder as empty rather than leaking the braces", () => {
    // A raw `{{user.nope}}` on someone's lock screen is worse than a gap.
    expect(interpolate("Hi {{user.nope}}!", scope)).toBe("Hi !");
  });

  it("ignores unknown roots", () => {
    expect(interpolate("{{order.total}}", scope)).toBe("{{order.total}}");
  });

  it("leaves non-placeholder braces alone", () => {
    expect(interpolate("a { b } c", scope)).toBe("a { b } c");
  });
});

describe("interpolateDeep", () => {
  it("walks strings nested in objects and arrays, leaving other types intact", () => {
    const result = interpolateDeep(
      {
        title: "{{event.product}}",
        body: "for {{user.firstName}}",
        count: 3,
        enabled: true,
        data: { sku: "{{event.meta.sku}}" },
        list: ["{{user.plan}}", 1],
      },
      scope,
    );

    expect(result).toEqual({
      title: "Widget",
      body: "for Ada",
      count: 3,
      enabled: true,
      data: { sku: "W-1" },
      list: ["pro", 1],
    });
  });
});
