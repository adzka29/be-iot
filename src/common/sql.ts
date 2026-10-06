/**
 * better-sqlite3 does not accept `undefined` or JS `boolean` as bind
 * parameters. Python's sqlite3 module is more forgiving, so every raw-SQL
 * call site in this port funnels its parameters through `bind()` first to
 * keep behaviour consistent with the FastAPI implementation.
 */
export function bindValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

export function bind(params: readonly unknown[]): unknown[] {
  return params.map(bindValue);
}
