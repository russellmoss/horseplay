import type { DecimalOdds } from '../types';

function gcd(a: number, b: number): number {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y > 0) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x || 1;
}

export function decimalToFractional(d: DecimalOdds): string {
  if (!Number.isFinite(d) || d <= 1) return '0/1';
  const margin = d - 1;
  for (const denom of [1, 2, 5, 4, 10, 20, 100]) {
    const num = margin * denom;
    if (Math.abs(num - Math.round(num)) < 1e-9) {
      const n = Math.round(num);
      const g = gcd(n, denom);
      return `${n / g}/${denom / g}`;
    }
  }
  const num = Math.round(margin * 100);
  const g = gcd(num, 100);
  return `${num / g}/${100 / g}`;
}

export function fractionalToDecimal(f: string): DecimalOdds {
  const parts = f.split('/');
  if (parts.length !== 2) {
    throw new Error(`Invalid fractional odds: ${f}`);
  }
  const num = Number(parts[0]);
  const den = Number(parts[1]);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) {
    throw new Error(`Invalid fractional odds: ${f}`);
  }
  return 1 + num / den;
}
