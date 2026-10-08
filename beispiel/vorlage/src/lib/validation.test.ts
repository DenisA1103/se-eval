import { expect, it } from "vitest";
import { validateOrder } from "./validation";

// Absichtlich schwacher Test: hohe Coverage, aber kaum Assertions -> niedriger Mutation Score
it("validiert Bestellungen", () => {
  validateOrder({ email: "a@b.de", items: [{ quantity: 1 }, { quantity: 0 }, { quantity: 120 }], country: "AT", express: true });
  validateOrder({ items: [{ quantity: 120 }], country: "AT" });
  expect(validateOrder({ email: "x", items: [] }).length).toBeGreaterThan(0);
});
