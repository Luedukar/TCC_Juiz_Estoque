import { useAuth } from '../lib/AuthContext';

/** Tela exibida quando o app abre e o servidor não responde (a sessão salva é mantida). */
export function ServerDown() {
  const { retryBoot } = useAuth();
  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <div className="w-full max-w-md border-2 border-ink bg-paper p-6" role="alert">
        <h1 className="text-xl font-semibold">Servidor fora do ar</h1>
        <p className="mt-2 text-ink-soft">
          Não foi possível conectar ao servidor de estoque. Sua sessão está guardada e o app tenta novamente a cada
          poucos segundos.
        </p>
        <button
          type="button"
          onClick={retryBoot}
          className="mt-5 h-11 rounded-[3px] bg-pallet px-5 font-semibold text-white hover:bg-pallet-dark"
        >
          Tentar agora
        </button>
      </div>
    </main>
  );
}
