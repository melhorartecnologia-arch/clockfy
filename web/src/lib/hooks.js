import { useCallback, useEffect, useRef, useState } from 'react';

// Generic async data hook: const {data, loading, error, reload, setData} = useAsync(() => api.get(...), [deps])
export function useAsync(fn, deps = [], { immediate = true, initial = null } = {}) {
  const [data, setData] = useState(initial);
  const [loading, setLoading] = useState(immediate);
  const [error, setError] = useState(null);
  const ref = useRef(fn); ref.current = fn;
  const reload = useCallback(async () => {
    setLoading(true); setError(null);
    try { const r = await ref.current(); setData(r); return r; } catch (e) { setError(e); throw e; } finally { setLoading(false); }
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (immediate) reload().catch(() => {}); }, deps);
  return { data, loading, error, reload, setData };
}

export function useInterval(cb, ms) {
  const ref = useRef(cb); ref.current = cb;
  useEffect(() => { if (ms == null) return undefined; const id = setInterval(() => ref.current(), ms); return () => clearInterval(id); }, [ms]);
}

export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useInterval(() => setNow(Date.now()), ms);
  return now;
}

export function useDebounce(value, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => { const id = setTimeout(() => setV(value), ms); return () => clearTimeout(id); }, [value, ms]);
  return v;
}

export function useLocalState(key, initial) {
  const [v, setV] = useState(() => { try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : initial; } catch { return initial; } });
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ } }, [key, v]);
  return [v, setV];
}
