import { expect, it } from "vitest";
import { validateOrder } from "./validation";

// Absichtlich schwacher Test: hohe Coverage, aber kaum Assertions -> niedriger Mutation Score
it("validiert Bestellungen", () => {
  validateOrder({ email: "a@b.de", items: [{ quantity: 1 }, { quantity: 0 }, { quantity: 120 }], country: "AT", express: true });
  validateOrder({ items: [{ quantity: 120 }], country: "AT" });
  expect(validateOrder({ email: "x", items: [] }).length).toBeGreaterThan(0);
});

it("meldet konkrete Fehler", () => {
  expect(validateOrder({ items: [] })).toEqual(["email missing"]);
  expect(validateOrder({ email: "x", items: [] })).toEqual(["email invalid"]);
  expect(validateOrder({ email: "a@b.de", items: [{ quantity: 0 }] })).toEqual(["quantity must be positive"]);
  expect(validateOrder({ email: "a@b.de", items: [{ quantity: 120 }], express: true })).toEqual(["express max 99"]);
  expect(validateOrder({ email: "a@b.de", items: [{ quantity: 120 }], country: "AT" })).toEqual(["export limit"]);
  expect(validateOrder({ email: "a@b.de", items: [], country: "AT", express: true })).toEqual(["express only DE"]);
});
