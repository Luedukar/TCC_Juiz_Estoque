import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

interface Props {
  open: boolean;
  title: string;
  confirmLabel: string;
  busy?: boolean;
  error?: string | null;
  children?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Confirmação de ações que não se desfazem (usa <dialog> nativo: foco preso e Esc fecha). */
export function ConfirmDialog({ open, title, confirmLabel, busy, error, children, onConfirm, onCancel }: Props) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
      className="m-auto w-[min(92vw,28rem)] border-2 border-ink bg-paper p-0 text-ink backdrop:bg-ink/50"
    >
      <div className="p-5">
        <h2 className="text-lg font-semibold">{title}</h2>
        <div className="mt-3 text-sm">{children}</div>
        {error && (
          <p role="alert" className="mt-3 border-l-4 border-tag-red bg-concrete px-3 py-2 text-sm font-medium">
            {error}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="h-11 rounded-[3px] border border-ink/50 px-4 font-semibold hover:bg-concrete disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="h-11 rounded-[3px] bg-pallet px-4 font-semibold text-white hover:bg-pallet-dark disabled:opacity-60"
          >
            {busy ? 'Enviando…' : confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
