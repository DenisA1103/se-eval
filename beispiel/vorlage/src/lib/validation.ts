export interface Order {
  email?: string;
  items: { quantity: number }[];
  country?: string;
  express?: boolean;
}

/** Absichtlich verschachtelt, damit die kognitive Komplexität > 15 liegt. */
export function validateOrder(order: Order): string[] {
  const errors: string[] = [];
  if (!order.email) {
    errors.push("email missing");
  } else {
    if (!order.email.includes("@")) {
      errors.push("email invalid");
    } else if (order.email.length > 100) {
      errors.push("email too long");
    }
  }
  for (const item of order.items) {
    if (item.quantity <= 0) {
      errors.push("quantity must be positive");
    } else {
      if (item.quantity > 99) {
        if (order.express) {
          errors.push("express max 99");
        } else {
          if (order.country !== "DE") {
            errors.push("export limit");
          }
        }
      }
    }
  }
  if (order.express && order.country && order.country !== "DE") {
    errors.push("express only DE");
  }
  return errors;
}

export function legacyCheck(value: string): boolean {
  // @ts-ignore -- absichtlich für die Messung
  return value.startsWith(42);
}
