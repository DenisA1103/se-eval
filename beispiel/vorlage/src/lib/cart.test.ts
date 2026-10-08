import { describe, expect, it } from "vitest";
import { applyDiscount, calcTotal, parseItem } from "./cart";

describe("cart", () => {
  it("summiert Positionen", () => {
    expect(calcTotal([{ id: "a", price: 2, quantity: 3 }, { id: "b", price: 1.5, quantity: 2 }])).toBe(9);
  });
  it("wendet Rabatt an", () => {
    expect(applyDiscount(100, 10)).toBe(90);
    expect(applyDiscount(100, 0)).toBe(100);
    expect(applyDiscount(100, 150)).toBe(0);
  });
  it("parst Rohdaten", () => {
    expect(parseItem({ id: 1, price: "2" })).toEqual({ id: "1", price: 2, quantity: 1 });
  });
});
