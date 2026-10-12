/**
 * Codificação de EAN-13 / EAN-8 (e UPC-A como EAN-13 com zero à esquerda) em barras,
 * para desenhar na etiqueta o código REAL do produto.
 */
const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
const R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

export interface EanBars {
  bits: string;
  /** Dígitos agrupados como impressos sob as barras. */
  groups: string[];
}

function checkDigitValid(code: string): boolean {
  const digits = code.split('').map(Number);
  const check = digits.pop() as number;
  const sum = digits.reduce((acc, d, i) => {
    const weight = code.length === 13 ? (i % 2 === 0 ? 1 : 3) : i % 2 === 0 ? 3 : 1;
    return acc + d * weight;
  }, 0);
  return (10 - (sum % 10)) % 10 === check;
}

export function eanBars(raw: string | null | undefined): EanBars | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const code = raw.length === 12 ? `0${raw}` : raw;
  if ((code.length !== 13 && code.length !== 8) || !checkDigitValid(code)) return null;
  const d = code.split('').map(Number);

  if (code.length === 13) {
    const parity = PARITY[d[0]];
    let bits = '101';
    for (let i = 0; i < 6; i++) bits += (parity[i] === 'L' ? L : G)[d[i + 1]];
    bits += '01010';
    for (let i = 7; i < 13; i++) bits += R[d[i]];
    bits += '101';
    return { bits, groups: [code[0], code.slice(1, 7), code.slice(7)] };
  }

  let bits = '101';
  for (let i = 0; i < 4; i++) bits += L[d[i]];
  bits += '01010';
  for (let i = 4; i < 8; i++) bits += R[d[i]];
  bits += '101';
  return { bits, groups: [code.slice(0, 4), code.slice(4)] };
}
