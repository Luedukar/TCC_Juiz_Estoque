import { eanBars } from '../lib/ean';

/** Desenha o código de barras real (EAN-13, EAN-8 ou UPC-A) a partir do número do produto. */
export function Barcode({ code }: { code: string | null }) {
  const ean = eanBars(code);

  if (!ean) {
    return (
      <p className="font-mono text-sm text-ink-soft">{code ? `${code} (código fora do padrão EAN)` : 'Sem código de barras'}</p>
    );
  }

  const quiet = 9;
  const width = ean.bits.length + quiet * 2;
  const rects: { x: number; w: number }[] = [];
  for (let i = 0; i < ean.bits.length; ) {
    if (ean.bits[i] === '1') {
      let j = i;
      while (j < ean.bits.length && ean.bits[j] === '1') j++;
      rects.push({ x: i + quiet, w: j - i });
      i = j;
    } else {
      i++;
    }
  }

  return (
    <svg
      viewBox={`0 0 ${width} 62`}
      role="img"
      aria-label={`Código de barras ${code}`}
      className="h-auto w-full max-w-[17rem]"
      preserveAspectRatio="xMidYMid meet"
    >
      {rects.map((r) => (
        <rect key={r.x} x={r.x} y={0} width={r.w} height={50} fill="#15202b" />
      ))}
      <text x={width / 2} y={60} textAnchor="middle" fontFamily="IBM Plex Mono, monospace" fontSize="9" letterSpacing="1.5" fill="#15202b">
        {ean.groups.join(' ')}
      </text>
    </svg>
  );
}
