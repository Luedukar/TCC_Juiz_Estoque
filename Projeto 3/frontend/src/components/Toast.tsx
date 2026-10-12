import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

type Tone = 'ok' | 'error' | 'info';
interface ToastItem {
  id: number;
  tone: Tone;
  text: string;
}
interface ToastApi {
  push: (t: { tone: Tone; text: string }) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const TONE: Record<Tone, string> = {
  ok: 'border-shelf-green',
  error: 'border-tag-red',
  info: 'border-pallet',
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const push = useCallback((t: { tone: Tone; text: string }) => {
    const id = ++seq.current;
    setItems((cur) => [...cur.slice(-3), { id, ...t }]);
    setTimeout(() => setItems((cur) => cur.filter((i) => i.id !== id)), t.tone === 'error' ? 8_000 : 4_500);
  }, []);

  const api = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex flex-col items-center gap-2 px-4 md:bottom-6"
      >
        {items.map((t) => (
          <div
            key={t.id}
            role={t.tone === 'error' ? 'alert' : 'status'}
            className={`pointer-events-auto max-w-md border-l-4 bg-ink px-4 py-3 text-sm text-paper ${TONE[t.tone]}`}
          >
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast fora do ToastProvider');
  return ctx;
}
