export interface CartItem {
  id: string;
  price: number;
  quantity: number;
}

/** Summe aller Positionen. */
export function calcTotal(items: CartItem[]): number {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}

/** Rabatt in Prozent anwenden, Ergebnis nie negativ. */
export function applyDiscount(total: number, percent: number): number {
  if (percent <= 0) return total;
  if (percent >= 100) return 0;
  return Math.round(total * (1 - percent / 100) * 100) / 100;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseItem(raw: any): CartItem {
  return { id: String(raw.id), price: Number(raw.price), quantity: Number(raw.quantity ?? 1) };
}
