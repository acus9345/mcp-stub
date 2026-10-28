/**
 * Checks `actual` against `expected` deeply. Objects match when every expected key matches,
 * so extra keys are fine. Arrays must match element by element. A RegExp tests a string.
 */
export function matches(actual: unknown, expected: unknown): boolean {
  if (expected instanceof RegExp) return typeof actual === "string" && expected.test(actual);
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item, i) => matches(actual[i], item))
    );
  }
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) return false;
    return Object.entries(expected).every(([key, value]) => key in actual && matches(actual[key], value));
  }
  return Object.is(actual, expected);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function describe(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (v instanceof RegExp ? String(v) : v));
}
