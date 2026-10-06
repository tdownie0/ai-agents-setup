import { useMemo, useState } from "react";

export type SortDirection = "asc" | "desc";

/**
 * Generic table-sort state: tracks the active column key and direction, and
 * returns a stably sorted copy of `rows` (the input array is never mutated).
 * Clicking the active column flips its direction; clicking a different column
 * sorts by it using `defaultDir[key]`, falling back to `"asc"`.
 */
export function useTableSort<T, K extends string>(
  rows: readonly T[],
  initialKey: K,
  compare: Record<K, (a: T, b: T) => number>,
  defaultDir: Partial<Record<K, SortDirection>> = {},
): {
  sortedRows: readonly T[];
  sortKey: K | null;
  sortDir: SortDirection;
  onSort: (key: K) => void;
} {
  const [state, setState] = useState<{ key: K | null; dir: SortDirection }>(() => ({
    key: initialKey,
    dir: defaultDir[initialKey] ?? "asc",
  }));

  const onSort = (key: K): void => {
    setState((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: defaultDir[key] ?? "asc" },
    );
  };

  const sortedRows = useMemo(() => {
    if (state.key === null) return rows;
    const copy = [...rows].sort(compare[state.key]);
    return state.dir === "desc" ? copy.reverse() : copy;
  }, [rows, compare, state.key, state.dir]);

  return { sortedRows, sortKey: state.key, sortDir: state.dir, onSort };
}
