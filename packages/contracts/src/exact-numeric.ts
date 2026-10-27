/** Authoritative values never pass through floating point. */
export function canonical(value: string): string | null {
  if (!/^\d+(?:\.\d+)?$/.test(value)) return null;
  let [i, f = ""] = value.split(".");
  i = i.replace(/^0+(?=\d)/, "");
  f = f.replace(/0+$/, "");
  return f ? `${i}.${f}` : i;
}
function parts(v: string) {
  const c = canonical(v);
  if (c === null) throw new Error("report_numeric_invalid");
  const [i, f = ""] = c.split(".");
  return { n: BigInt(i + f), scale: f.length };
}
export function compareExact(a: string, b: string): number {
  const x = parts(a),
    y = parts(b),
    s = Math.max(x.scale, y.scale);
  const l = x.n * 10n ** BigInt(s - x.scale),
    r = y.n * 10n ** BigInt(s - y.scale);
  return l < r ? -1 : l > r ? 1 : 0;
}
export function sumExact(values: Iterable<string>): string {
  let n = 0n,
    s = 0;
  for (const v of values) {
    const p = parts(v),
      next = Math.max(s, p.scale);
    n = n * 10n ** BigInt(next - s) + p.n * 10n ** BigInt(next - p.scale);
    s = next;
  }
  const t = n.toString().padStart(s + 1, "0");
  return canonical(s ? t.slice(0, -s) + "." + t.slice(-s) : t)!;
}
export function compareNullable(
  a: string | null,
  b: string | null,
  direction: "asc" | "desc" = "asc"
) {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  return compareExact(a, b) * (direction === "desc" ? -1 : 1);
}
export function sortComponents(value: string | null): {
  numericClass: number;
  exponent: number;
  digits: string;
} {
  if (value === null) return { numericClass: 2, exponent: 0, digits: "" };
  const c = canonical(value)!;
  if (c === "0") return { numericClass: 0, exponent: 0, digits: "" };
  const [i, f = ""] = c.split(".");
  return {
    numericClass: 1,
    exponent: i !== "0" ? i.length : -f.search(/[1-9]/),
    digits: (i + f).replace(/^0+/, "").replace(/0+$/, "")
  };
}
