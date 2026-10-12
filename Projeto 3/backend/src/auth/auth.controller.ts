import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthUser } from '../common/types';
import { CurrentUser } from './current-user.decorator';
import { LoginDto, RefreshDto } from './auth.dto';
import { AuthService } from './auth.service';
import { Public } from './public.decorator';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  // O limite estrito (RATE_LIMIT_AUTH) vale para /auth/login, /auth/refresh e /auth/logout — ver AppModule.

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.auth.login(dto.email, dto.password, { ip: req.ip, userAgent: req.headers['user-agent'] });
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() dto: RefreshDto, @Req() req: Request) {
    return this.auth.refresh(dto.refreshToken, { ip: req.ip, userAgent: req.headers['user-agent'] });
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Body() dto: RefreshDto): Promise<void> {
    await this.auth.logout(dto.refreshToken);
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.id);
  }
}
