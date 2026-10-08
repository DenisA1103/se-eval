export function formatEuro(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  const parts = rounded.toFixed(2).split(".");
  const whole = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const result = whole + "," + parts[1] + " €";
  return result;
}

export function formatEuroNegative(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  const parts = rounded.toFixed(2).split(".");
  const whole = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const result = whole + "," + parts[1] + " €";
  return "-" + result;
}
