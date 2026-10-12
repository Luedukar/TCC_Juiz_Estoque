import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { env } from '../config/env';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

@Module({
  imports: [
    JwtModule.register({
      global: true, // os guards globais (registrados no AppModule) precisam do JwtService
      secret: env.jwtSecret,
      signOptions: { algorithm: 'HS256', expiresIn: env.accessTtlSeconds },
      verifyOptions: { algorithms: ['HS256'] },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}
