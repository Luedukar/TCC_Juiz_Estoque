import { useEffect, useState } from 'react';
import { useAuth } from '../lib/AuthContext';
import { connection } from '../lib/connection';
import { plural } from '../lib/format';
import { useConnection, useOutbox } from '../lib/hooks';

interface Props {
  syncNow: () => Promise<void>;
}

/**
 * Faixa fixa no topo:
 *  - offline: explica o que acontece com o trabalho e mostra a próxima tentativa;
 *  - online com pendências: mostra quantas movimentações aguardam envio.
 */
export function ConnectionBanner({ syncNow }: Props) {
  const conn = useConnection();
  const { user } = useAuth();
  const outboxItems = useOutbox();
  const pending = outboxItems.filter((i) => i.userId === user?.id && i.status === 'pending').length;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (conn.status !== 'offline') return;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [conn.status]);

  if (conn.status === 'offline') {
    const secs = conn.nextProbeAt ? Math.max(0, Math.ceil((conn.nextProbeAt - now) / 1000)) : 0;
    return (
      <div role="alert" className="border-b-2 border-ink bg-caution-fill text-ink">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 md:px-8">
          <p className="min-w-0 flex-1 text-sm font-medium">
            Sem conexão com o servidor. Você pode continuar registrando movimentações: elas ficam guardadas neste
            aparelho e são enviadas quando a conexão voltar.
            {pending > 0 && ` Aguardando envio: ${pending}.`}
          </p>
          <span className="text-sm tabular-nums">
            {conn.nextProbeAt ? `Nova tentativa em ${secs} s` : 'Verificando…'}
          </span>
          <button
            type="button"
            onClick={() => connection.probeNow()}
            className="h-9 rounded-[3px] border-2 border-ink px-3 text-sm font-semibold hover:bg-ink hover:text-paper"
          >
            Tentar agora
          </button>
        </div>
      </div>
    );
  }

  if (pending > 0) {
    return (
      <div role="status" className="border-b border-pallet bg-pallet-wash">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-2.5 md:px-8">
          <p className="flex-1 text-sm">
            {pending} {plural(pending, 'movimentação aguardando envio', 'movimentações aguardando envio')} ao servidor.
          </p>
          <button
            type="button"
            onClick={() => void syncNow()}
            className="h-9 rounded-[3px] border border-pallet px-3 text-sm font-semibold text-pallet hover:bg-pallet hover:text-white"
          >
            Enviar agora
          </button>
        </div>
      </div>
    );
  }

  return null;
}
