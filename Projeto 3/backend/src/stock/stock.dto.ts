import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export const REASONS_ENTRADA = ['COMPRA', 'DEVOLUCAO_CLIENTE', 'AJUSTE_INVENTARIO', 'OUTRO'] as const;
export const REASONS_SAIDA = ['VENDA', 'DEVOLUCAO_FORNECEDOR', 'PERDA_AVARIA', 'AJUSTE_INVENTARIO', 'OUTRO'] as const;
const ALL_REASONS = Array.from(new Set([...REASONS_ENTRADA, ...REASONS_SAIDA]));

export type MovementKind = 'ENTRADA' | 'SAIDA';

export class CreateMovementDto {
  // Identificação do produto: informe EXATAMENTE um entre productId, barcode (leitor) ou sku.
  @IsOptional()
  @IsUUID()
  productId?: string;

  @IsOptional()
  @Transform(trim)
  @Matches(/^[0-9]{8,14}$/, { message: 'barcode deve ter de 8 a 14 dígitos' })
  barcode?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(50)
  sku?: string;

  @IsIn(['ENTRADA', 'SAIDA'])
  type!: MovementKind;

  @IsOptional()
  @IsIn(ALL_REASONS)
  reason?: string;

  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 3 })
  @Min(0.001)
  @Max(99_999_999_999)
  quantity!: number;

  /** Custo unitário (somente GERENTE, somente ENTRADA). */
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9_999_999_999.99)
  unitCost?: number;

  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(60)
  documentRef?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class ReverseMovementDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class PagingDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 50;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;
}

export class MovementsQueryDto extends PagingDto {
  @IsOptional()
  @IsUUID()
  productId?: string;

  @IsOptional()
  @IsIn(['ENTRADA', 'SAIDA'])
  type?: MovementKind;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;
}

export class KardexQueryDto extends PagingDto {
  @IsUUID()
  productId!: string;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;
}

export class BalancesQueryDto extends PagingDto {
  /** Leitura de código de barras: busca exata. */
  @IsOptional()
  @Transform(trim)
  @Matches(/^[0-9]{8,14}$/, { message: 'barcode deve ter de 8 a 14 dígitos' })
  barcode?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(50)
  sku?: string;

  /** Busca parcial por nome, SKU ou código de barras (sem diferenciar maiúsculas). */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @IsIn(['ZERADO', 'BAIXO', 'OK'])
  status?: 'ZERADO' | 'BAIXO' | 'OK';
}
