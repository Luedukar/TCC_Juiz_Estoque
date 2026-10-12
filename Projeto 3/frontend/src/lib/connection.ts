import { API_BASE } from './config';

/**
 * Monitor de conexão com o servidor.
 *  - 2 falhas de rede seguidas (ou o evento "offline" do navegador) => offline;
 *  - offline: sondagem de GET /health com intervalo crescente (4 s → 15 s);
 *  - primeira resposta bem-sucedida => online e dispara os ouvintes de reconexão
 *    (atualizar telas, reenviar a fila de movimentações).
 */
export type ConnectionStatus = 'online' | 'offline';

export interface ConnectionState {
  status: ConnectionStatus;
  since: number;
  nextProbeAt: number | null;
  failures: number;
}

const FIRST_DELAY = 4_000;
const MAX_DELAY = 15_000;

let state: ConnectionState = { status: 'online', since: Date.now(), nextProbeAt: null, failures: 0 };
const listeners = new Set<() => void>();
const reconnectListeners = new Set<() => void>();
let probeTimer: ReturnType<typeof setTimeout> | undefined;
let probeDelay = FIRST_DELAY;
let probing = false;

function set(next: Partial<ConnectionState>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

function scheduleProbe(delay: number) {
  clearTimeout(probeTimer);
  set({ nextProbeAt: Date.now() + delay });
  probeTimer = setTimeout(() => void probe(), delay);
}

async function probe() {
  if (probing || state.status !== 'offline') return;
  probing = true;
  set({ nextProbeAt: null });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4_000);
  let ok = false;
  try {
    const res = await fetch(`${API_BASE}/health`, { signal: ctrl.signal, cache: 'no-store' });
    ok = res.ok;
  } catch {
    ok = false;
  } finally {
    clearTimeout(timer);
    probing = false;
  }
  if (ok) {
    connection.reportSuccess();
  } else if (state.status === 'offline') {
    probeDelay = Math.min(Math.round(probeDelay * 1.5), MAX_DELAY);
    scheduleProbe(probeDelay);
  }
}

export const connection = {
  getState: (): ConnectionState => state,

  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },

  onReconnect(fn: () => void) {
    reconnectListeners.add(fn);
    return () => {
      reconnectListeners.delete(fn);
    };
  },

  reportSuccess() {
    if (state.status === 'offline') {
      clearTimeout(probeTimer);
      probeDelay = FIRST_DELAY;
      set({ status: 'online', since: Date.now(), nextProbeAt: null, failures: 0 });
      reconnectListeners.forEach((l) => l());
    } else if (state.failures > 0) {
      set({ failures: 0 });
    }
  },

  reportFailure() {
    const failures = state.failures + 1;
    if (state.status === 'offline') {
      set({ failures });
    } else if (failures >= 2 || !navigator.onLine) {
      probeDelay = FIRST_DELAY;
      set({ status: 'offline', since: Date.now(), failures });
      scheduleProbe(probeDelay);
    } else {
      set({ failures });
    }
  },

  /** "Tentar agora": sonda imediatamente em vez de esperar o próximo intervalo. */
  probeNow() {
    if (state.status !== 'offline') return;
    clearTimeout(probeTimer);
    void probe();
  },
};

if (typeof window !== 'undefined') {
  window.addEventListener('offline', () => {
    if (state.status === 'online') {
      probeDelay = FIRST_DELAY;
      set({ status: 'offline', since: Date.now() });
      scheduleProbe(probeDelay);
    }
  });
  window.addEventListener('online', () => connection.probeNow());
}
