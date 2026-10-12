import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { SignOptions } from 'jsonwebtoken';
import { z } from 'zod';
import { pool } from '../db';
import { HttpError } from '../errors';

export const authRouter = Router();
const loginSchema = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(200) });

authRouter.post('/login', async (req, res, next) => {
  try {
    const { email, password } = loginSchema.parse(req.body);
    const result = await pool.query('SELECT id, password_hash, role FROM app_users WHERE lower(email) = lower($1) AND active = true', [email]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      throw new HttpError(401, 'E-mail ou senha inválidos.', 'INVALID_CREDENTIALS');
    }
    const secret = process.env.JWT_SECRET;
    if (!secret || secret.length < 32) throw new Error('JWT_SECRET ausente ou curto');
    const expiresIn = (process.env.JWT_EXPIRES_IN || '8h') as SignOptions['expiresIn'];
    const token = jwt.sign({ role: user.role }, secret, { subject: String(user.id), expiresIn });
    res.json({ token, token_type: 'Bearer', expires_in: process.env.JWT_EXPIRES_IN || '8h' });
  } catch (error) { next(error); }
});
