import { useEffect, useRef, useSyncExternalStore } from 'react';
import { connection } from './connection';
import { outbox } from './outbox';

export const useConnection = () => useSyncExternalStore(connection.subscribe, connection.getState);
export const useOutbox = () => useSyncExternalStore(outbox.subscribe, outbox.getSnapshot);

type Handler = (e: KeyboardEvent) => void;

function keyName(e: KeyboardEvent): string {
  const digit = /^Digit(\d)$/.exec(e.code);
  if (digit) return digit[1];
  const letter = /^Key([A-Z])$/.exec(e.code);
  if (letter) return letter[1].toLowerCase();
  return e.key.toLowerCase();
}

function combo(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  parts.push(keyName(e));
  return parts.join('+');
}

const isEditable = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));

/**
 * Atalhos de teclado. Chaves: "alt+1", "ctrl+enter", "escape", "/".
 * Atalhos sem modificador (como "/") são ignorados enquanto se digita em um campo.
 */
export function useHotkeys(bindings: Record<string, Handler>) {
  const ref = useRef(bindings);
  ref.current = bindings;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const c = combo(e);
      const handler = ref.current[c];
      if (!handler) return;
      const hasModifier = c.includes('+') || c === 'escape';
      if (!hasModifier && isEditable(e.target)) return;
      e.preventDefault();
      handler(e);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
