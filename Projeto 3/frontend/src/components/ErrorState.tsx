import { describeError } from '../lib/errors';

interface Props {
  error: unknown;
  onRetry?: () => void;
}

/** Falha ao carregar uma área da tela: diz o que houve e oferece repetir. */
export function ErrorState({ error, onRetry }: Props) {
  const { message, network } = describeError(error);
  return (
    <div role="alert" className="border border-line border-l-4 border-l-tag-red bg-paper p-4">
      <p className="font-medium">{message}</p>
      {network && (
        <p className="mt-1 text-sm text-ink-soft">Os dados voltam a aparecer assim que a conexão for restabelecida.</p>
      )}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 h-10 rounded-[3px] border border-ink/50 px-4 text-sm font-semibold hover:bg-concrete"
        >
          Tentar de novo
        </button>
      )}
    </div>
  );
}

export function Skeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="divide-y divide-line border border-line bg-paper" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="space-y-2 px-4 py-4">
          <div className="h-4 w-1/2 bg-concrete-deep" />
          <div className="h-2.5 w-full bg-concrete" />
        </div>
      ))}
    </div>
  );
}
