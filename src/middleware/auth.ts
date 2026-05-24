import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env';

declare module 'express-session' {
  interface SessionData {
    isAuthenticated?: boolean;
    username?: string;
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.session?.isAuthenticated) {
    next();
    return;
  }

  // For API requests return 401
  if (req.path.startsWith('/api/')) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  // For page requests redirect to login
  res.redirect('/login');
}

export function handleLogin(req: Request, res: Response): void {
  const { username, password } = req.body;

  if (username === env.admin.username && password === env.admin.password) {
    req.session.isAuthenticated = true;
    req.session.username = username;
    res.redirect('/');
    return;
  }

  res.render('login', { error: 'Invalid credentials' });
}

export function handleLogout(req: Request, res: Response): void {
  req.session.destroy(() => {
    res.redirect('/login');
  });
}
