import { Body, Controller, Get, Headers, Param, ParseIntPipe, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../auth/current-user.decorator';
import { Roles } from '../auth/roles.decorator';
import { AppError } from '../common/app-error';
import type { AuthUser } from '../common/types';
import {
  BalancesQueryDto,
  CreateMovementDto,
  KardexQueryDto,
  MovementsQueryDto,
  ReverseMovementDto,
} from './stock.dto';
import { StockQueryService } from './stock-query.service';
import { MovementResult, StockService } from './stock.service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseIdempotencyKey(raw: string | undefined): string | null {
  if (raw === undefined || raw === '') return null;
  if (!UUID_RE.test(raw)) {
    throw new AppError(400, 'INVALID_IDEMPOTENCY_KEY', 'O cabeçalho Idempotency-Key deve ser um UUID.');
  }
  return raw.toLowerCase();
}

function respond(res: Response, r: MovementResult) {
  res.status(r.replayed ? 200 : 201);
  if (r.replayed) res.setHeader('Idempotent-Replayed', 'true');
  return { data: r.movement };
}

@Controller('stock')
export class StockController {
  constructor(
    private readonly stock: StockService,
    private readonly queries: StockQueryService,
  ) {}

  /** Entrada ou saída. Aceita `Idempotency-Key` (UUID) para reenvio seguro após falha de rede. */
  @Post('movements')
  async create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateMovementDto,
    @Headers('idempotency-key') idem: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    return respond(res, await this.stock.create(user, dto, parseIdempotencyKey(idem)));
  }

  /** Estorno de uma movimentação (somente GERENTE). */
  @Post('movements/:id/reversal')
  @Roles('GERENTE')
  async reverse(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ReverseMovementDto,
    @Headers('idempotency-key') idem: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    return respond(res, await this.stock.reverse(user, id, dto, parseIdempotencyKey(idem)));
  }

  @Get('movements')
  movements(@CurrentUser() user: AuthUser, @Query() q: MovementsQueryDto) {
    return this.queries.movements(user.role, q);
  }

  @Get('kardex')
  kardex(@CurrentUser() user: AuthUser, @Query() q: KardexQueryDto) {
    return this.queries.kardex(user.role, q);
  }

  @Get('balances')
  balances(@Query() q: BalancesQueryDto) {
    return this.queries.balances(q);
  }

  @Get('alerts')
  alerts() {
    return this.queries.alerts();
  }
}
