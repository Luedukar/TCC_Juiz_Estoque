import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { authRouter } from './routes/auth';
import { movementRouter } from './routes/movements';
import { errorHandler } from './errors';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL é obrigatório');
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) throw new Error('JWT_SECRET deve ter pelo menos 32 caracteres');

export const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(cors({ origin: process.env.CLIENT_ORIGIN?.split(',') ?? false }));
app.use(express.json({ limit: '1mb' }));

const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: 'draft-7', legacyHeaders: false });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Muitas tentativas. Tente novamente mais tarde.' } } });
app.use('/api', apiLimiter);
app.use('/api/auth/login', loginLimiter);
app.use('/api/auth', authRouter);
app.use('/api/movements', movementRouter);
app.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Rota não encontrada.' } }));
app.use(errorHandler);
