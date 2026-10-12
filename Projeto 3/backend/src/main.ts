import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { env } from './config/env';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  configureApp(app);
  app.enableShutdownHooks();
  await app.listen(env.port);
  new Logger('Bootstrap').log(`API ouvindo em http://localhost:${env.port}/api`);
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
