import { INestApplication, ValidationError, ValidationPipe } from '@nestjs/common';
import { json } from 'express';
import helmet from 'helmet';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { AppError } from './common/app-error';
import { requestContext } from './common/request-context';
import { env } from './config/env';

function flatten(errors: ValidationError[], parent = ''): { field: string; messages: string[] }[] {
  return errors.flatMap((e) => {
    const field = parent ? `${parent}.${e.property}` : e.property;
    const own = e.constraints ? [{ field, messages: Object.values(e.constraints) }] : [];
    return [...own, ...flatten(e.children ?? [], field)];
  });
}

/** Configuração compartilhada entre main.ts e os testes de integração. */
export function configureApp(app: INestApplication): void {
  const express = app.getHttpAdapter().getInstance();
  express.set('trust proxy', env.trustProxy);
  express.disable('x-powered-by');

  app.use(requestContext);
  app.use(helmet());
  app.use(json({ limit: '100kb' }));

  app.setGlobalPrefix('api');
  app.enableCors({
    origin: env.corsOrigins,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Request-Id'],
    exposedHeaders: ['Retry-After', 'X-Request-Id', 'Idempotent-Replayed'],
    maxAge: 600,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: (errors) => new AppError(400, 'VALIDATION_ERROR', 'Dados inválidos.', flatten(errors)),
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
}
