import { useCallback, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '../components/Toast';
import { useAuth } from './AuthContext';
import { connection } from './connection';
import { plural } from './format';
import { useConnection } from './hooks';
import { outbox } from './outbox';

/**
 * Reenvia a fila de movimentações pendentes:
 *  - quando a conexão volta, e ao abrir o app já online;
 *  - de 30 em 30 s enquanto houver pendências (cobre recusas temporárias, como rate limit).
 * Também atualiza todas as telas ao reconectar.
 */
export function useOutboxSync(): () => Promise<void> {
  const { user } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const { status } = useConnection();

  const run = useCallback(async () => {
    if (!user) return;
    const r = await outbox.flush(user.id);
    if (r.sent > 0) {
      toast.push({ tone: 'ok', text: `${r.sent} ${plural(r.sent, 'movimentação enviada', 'movimentações enviadas')} ao servidor.` });
      void qc.invalidateQueries();
    }
    if (r.failed > 0) {
      toast.push({
        tone: 'error',
        text: `${r.failed} ${plural(r.failed, 'movimentação foi recusada', 'movimentações foram recusadas')} pelo servidor. Veja em Movimentação.`,
      });
    }
  }, [user, qc, toast]);

  useEffect(
    () =>
      connection.onReconnect(() => {
        void qc.invalidateQueries();
        void run();
      }),
    [qc, run],
  );

  useEffect(() => {
    if (status === 'online') void run();
    const id = setInterval(() => {
      if (connection.getState().status === 'online') void run();
    }, 30_000);
    return () => clearInterval(id);
  }, [status, run]);

  return run;
}
