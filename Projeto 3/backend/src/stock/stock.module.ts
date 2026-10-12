import { Module } from '@nestjs/common';
import { StockController } from './stock.controller';
import { StockQueryService } from './stock-query.service';
import { StockService } from './stock.service';

@Module({
  controllers: [StockController],
  providers: [StockService, StockQueryService],
})
export class StockModule {}
