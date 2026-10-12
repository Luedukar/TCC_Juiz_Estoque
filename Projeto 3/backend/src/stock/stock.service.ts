import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AppError } from '../common/app-error';
import type { AuthUser } from '../common/types';
import { DatabaseService } from '../database/database.service';
import {
  CreateMovementDto,
  MovementKind,
  REASONS_ENTRADA,
  REASONS_SAIDA,
  ReverseMovementDto,
} from './stock.dto';
import { toMovement } from './stock.mapper';

export interface MovementResult {
  replayed: boolean;
  movement: ReturnType<typeof toMovement>;
}

const IDEMPOTENCY_CONSTRAINT = 'stock_movements_idempotency_key_key';
const REVERSAL_CONSTRAINT = 'stock_movements_reversal_of_id_key';

@Injectable()
export class StockService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Registra uma entrada/saída. O saldo é calculado e protegido pelo trigger do banco
   * (lock da linha do produto + recusa de saldo negativo).
   */
  async create(user: AuthUser, dto: CreateMovementDto, idempotencyKey: string | null): Promise<MovementResult> {
    if (dto.unitCost !== undefined) {
      if (user.role !== 'GERENTE') {
        throw new AppError(403, 'FORBIDDEN_FIELD', 'Somente o Gerente pode informar custos.');
      }
      if (dto.type === 'SAIDA') {
        throw new AppError(400, 'INVALID_FIELD', 'unitCost só se aplica a entradas.');
      }
    }

    const reason = dto.reason ?? 'OUTRO';
    const allowed: readonly string[] = dto.type === 'ENTRADA' ? REASONS_ENTRADA : REASONS_SAIDA;
    if (!allowed.includes(reason)) {
      throw new AppError(400, 'INVALID_REASON', `Motivo ${reason} não é válido para ${dto.type}.`, { allowed });
    }

    const productId = await this.resolveProductId(dto);

    return this.insertMovement(user, idempotencyKey, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO stock_movements
           (product_id, type, reason, quantity, unit_cost, supplier_id, document_ref, notes, idempotency_key, user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id`,
        [
          productId,
          dto.type,
          reason,
          dto.quantity,
          dto.unitCost ?? null,
          dto.supplierId ?? null,
          dto.documentRef ?? null,
          dto.notes ?? null,
          idempotencyKey,
          user.id,
        ],
      );
      return rows[0].id as string;
    });
  }

  /** Estorno: cria a movimentação inversa. Nada é apagado nem alterado. Somente GERENTE (ver controller). */
  async reverse(
    user: AuthUser,
    originalId: number,
    dto: ReverseMovementDto,
    idempotencyKey: string | null,
  ): Promise<MovementResult> {
    return this.insertMovement(user, idempotencyKey, async (c) => {
      const orig = await c.query(`SELECT product_id, type, quantity FROM stock_movements WHERE id = $1`, [originalId]);
      if (!orig.rows[0]) throw new AppError(404, 'MOVEMENT_NOT_FOUND', 'Movimentação não encontrada.');
      const o = orig.rows[0] as { product_id: string; type: MovementKind; quantity: string };

      const { rows } = await c.query(
        `INSERT INTO stock_movements
           (product_id, type, reason, quantity, reversal_of_id, notes, idempotency_key, user_id)
         VALUES ($1, $2, 'ESTORNO', $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          o.product_id,
          o.type === 'ENTRADA' ? 'SAIDA' : 'ENTRADA',
          o.quantity,
          originalId,
          dto.notes ?? null,
          idempotencyKey,
          user.id,
        ],
      );
      return rows[0].id as string;
    });
  }

  /**
   * Executa o INSERT em transação e devolve a movimentação formatada.
   * Se a mesma Idempotency-Key já foi usada pelo mesmo usuário (reenvio após falha de rede),
   * devolve a movimentação original em vez de duplicar o lançamento.
   */
  private async insertMovement(
    user: AuthUser,
    idempotencyKey: string | null,
    insert: (c: PoolClient) => Promise<string>,
  ): Promise<MovementResult> {
    try {
      const row = await this.db.tx(user.id, async (c) => {
        const id = await insert(c);
        const { rows } = await c.query(`SELECT * FROM v_kardex WHERE id = $1`, [id]);
        return rows[0];
      });
      return { replayed: false, movement: toMovement(row, user.role) };
    } catch (err) {
      const e = err as { code?: string; constraint?: string };
      // Um reenvio de ESTORNO viola duas unicidades de uma vez (a chave e o reversal_of_id) e o PostgreSQL
      // informa a primeira que verificar. Por isso as duas são tratadas: se a chave já existe, é reenvio.
      const mayBeReplay = e.code === '23505' && (e.constraint === IDEMPOTENCY_CONSTRAINT || e.constraint === REVERSAL_CONSTRAINT);
      if (idempotencyKey && mayBeReplay) {
        const existing = await this.db.query(
          `SELECT k.*, m.user_id FROM v_kardex k JOIN stock_movements m ON m.id = k.id WHERE m.idempotency_key = $1`,
          [idempotencyKey],
        );
        const row = existing.rows[0];
        if (row && row.user_id === user.id) {
          return { replayed: true, movement: toMovement(row, user.role) };
        }
        if (row) {
          throw new AppError(409, 'IDEMPOTENCY_KEY_CONFLICT', 'Idempotency-Key já utilizada em outra operação.');
        }
      }
      throw err; // sem chave (ou chave inédita): segue como erro normal, ex.: 409 DUPLICATE ao estornar duas vezes
    }
  }

  private async resolveProductId(dto: CreateMovementDto): Promise<string> {
    const provided = (
      [
        ['id', dto.productId],
        ['barcode', dto.barcode],
        ['sku', dto.sku],
      ] as const
    ).filter(([, v]) => v !== undefined && v !== '');

    if (provided.length !== 1) {
      throw new AppError(400, 'PRODUCT_IDENTIFIER_REQUIRED', 'Informe exatamente um entre productId, barcode ou sku.');
    }
    const [column, value] = provided[0]; // `column` vem de uma lista fixa — nunca de entrada do usuário
    const { rows } = await this.db.query(`SELECT id FROM products WHERE ${column} = $1`, [value]);
    if (!rows[0]) throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Produto não encontrado.');
    return rows[0].id as string;
  }
}
