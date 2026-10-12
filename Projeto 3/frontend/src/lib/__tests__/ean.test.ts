import { describe, expect, it } from 'vitest';
import { eanBars } from '../ean';
import { parseDecimal } from '../format';

describe('EAN para barras', () => {
  it('codifica EAN-13 com 95 módulos (3 + 42 + 5 + 42 + 3)', () => {
    const e = eanBars('7891000100103');
    expect(e?.bits).toHaveLength(95);
    expect(e?.bits.startsWith('101')).toBe(true);
    expect(e?.bits.endsWith('101')).toBe(true);
    expect(e?.bits.slice(45, 50)).toBe('01010');
    expect(e?.groups).toEqual(['7', '891000', '100103']);
  });

  it('codifica EAN-8 com 67 módulos', () => {
    expect(eanBars('96385074')?.bits).toHaveLength(67);
  });

  it('aceita UPC-A (12 dígitos) como EAN-13 com zero à esquerda', () => {
    expect(eanBars('036000291452')?.groups[0]).toBe('0');
  });

  it('recusa dígito verificador inválido e formatos não EAN', () => {
    expect(eanBars('7891000100104')).toBeNull();
    expect(eanBars('12345')).toBeNull();
    expect(eanBars('abc')).toBeNull();
    expect(eanBars(null)).toBeNull();
  });
});

describe('parseDecimal', () => {
  it('aceita vírgula, ponto e milhar', () => {
    expect(parseDecimal('1,5')).toBe(1.5);
    expect(parseDecimal('1.5')).toBe(1.5);
    expect(parseDecimal('1.234,5')).toBe(1234.5);
    expect(parseDecimal('12')).toBe(12);
  });

  it('recusa vazio, negativo, texto e casas demais', () => {
    expect(parseDecimal('')).toBeNull();
    expect(parseDecimal('-1')).toBeNull();
    expect(parseDecimal('abc')).toBeNull();
    expect(parseDecimal('1,2345')).toBeNull();
    expect(parseDecimal('10,999', 2)).toBeNull();
  });
});
