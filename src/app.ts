import express from 'express';
import path from 'path';
import fs from 'fs';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import session from 'express-session';
import { env } from './config/env';
import { requireAuth, handleLogin, handleLogout } from './middleware/auth';
import webhookRouter from './routes/webhook';
import apiRouter from './routes/api';
import adminRouter from './routes/admin';
import { startWorker } from './services/queue';
import { db } from './config/database';
import { Logger } from './services/logger';

const app = express();

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));

// Static files
app.use('/static', express.static(path.join(__dirname, '../public')));

// Middleware
app.use(cors());
app.use(
  helmet({
    contentSecurityPolicy: false,
  })
);
app.use(morgan('short'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: env.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
      httpOnly: true,
    },
  })
);

// ============ PUBLIC ROUTES ============

// Webhook endpoint (no auth — MoySklad calls this)
app.use('/api/webhook', webhookRouter);

// Login page
app.get('/login', (_req, res) => {
  res.render('login', { error: null });
});
app.post('/login', handleLogin);
app.get('/logout', handleLogout);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ============ PROTECTED ROUTES ============
app.use('/api', requireAuth, apiRouter);
app.use('/', requireAuth, adminRouter);

// ============ START SERVER ============
async function bootstrap() {
  try {
    // Test DB connection
    await db.raw('SELECT 1');
    console.log('[DB] PostgreSQL connected');

    // Run migrations
    await db.migrate.latest({
      directory: path.join(__dirname, 'migrations'),
      loadExtensions: ['.js'],
    });
    console.log('[DB] Migrations executed');

    // Start BullMQ worker
    startWorker();

    // Start Express
    app.listen(env.port, () => {
      console.log(`[Server] MoySklad Integration Hub running on http://localhost:${env.port}`);
      Logger.info('Server started', undefined, { port: env.port });
    });
  } catch (err: any) {
    fs.writeFileSync(
      path.join(process.cwd(), 'startup-error.log'),
      `${new Date().toISOString()} ${err?.stack || err?.message || String(err)}\n`
    );
    console.error('[FATAL] Failed to start:', err.message);
    process.exit(1);
  }
}

bootstrap();

export default app;
