import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { AppError } from '../common/app-error';
import { DatabaseService } from '../database/database.service';
import { Public } from '../auth/public.decorator';

@Controller('health')
export class HealthController {
  constructor(private readonly db: DatabaseService) {}

  /** Usado pelo frontend para detectar indisponibilidade e pelo orquestrador (liveness/readiness). */
  @Public()
  @SkipThrottle()
  @Get()
  async check() {
    try {
      await this.db.query('SELECT 1');
    } catch {
      throw new AppError(503, 'DB_UNAVAILABLE', 'Banco de dados indisponível.');
    }
    return { status: 'ok', time: new Date().toISOString() };
  }
}
