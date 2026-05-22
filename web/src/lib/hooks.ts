import { useEffect, useState } from "react";

/**
 * Debounce a value — useful for search inputs so the filter pass doesn't
 * run on every keystroke. Keeps the input "live" but defers the
 * downstream work.
 */
export function useDebounced<T>(value: T, delayMs = 200): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}
