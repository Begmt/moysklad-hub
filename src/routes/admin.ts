import { Router, Request, Response } from 'express';
import { db } from '../config/database';

const router = Router();

router.get('/', async (_req: Request, res: Response) => {
  try {
    const groups = await db('account_groups').orderBy('id');
    const accounts = await db('accounts')
      .leftJoin('account_groups', 'accounts.group_id', 'account_groups.id')
      .select('accounts.*', 'account_groups.name as group_name')
      .orderBy('accounts.id');

    // Mask tokens for display
    accounts.forEach((a: any) => {
      a.api_token_masked = a.api_token ? `${a.api_token.substring(0, 8)}...` : '';
    });

    const routes = await db('routes')
      .join('accounts as src', 'routes.source_account_id', 'src.id')
      .join('accounts as tgt', 'routes.target_account_id', 'tgt.id')
      .select(
        'routes.*',
        'src.name as source_account_name',
        'src.group_id as source_group_id',
        'tgt.name as target_account_name',
        'tgt.group_id as target_group_id'
      )
      .orderBy('routes.id');

    const recentLogs = await db('sync_logs')
      .leftJoin('account_groups', 'sync_logs.group_id', 'account_groups.id')
      .select('sync_logs.*', 'account_groups.name as group_name')
      .orderBy('sync_logs.created_at', 'desc')
      .limit(50);

    const stats = {
      totalGroups: groups.length,
      totalAccounts: accounts.length,
      totalRoutes: routes.length,
      activeRoutes: routes.filter((r: any) => r.is_active).length,
      errorsToday: await db('sync_logs')
        .where('level', 'ERROR')
        .where('created_at', '>=', db.raw("CURRENT_DATE"))
        .count('* as count')
        .first()
        .then((r: any) => Number(r?.count || 0)),
    };

    res.render('dashboard', { groups, accounts, routes, logs: recentLogs, stats });
  } catch (err: any) {
    res.status(500).send(`Error loading dashboard: ${err.message}`);
  }
});

router.get('/logs', async (req: Request, res: Response) => {
  try {
    const { group_id, level, page = '1' } = req.query;
    const limit = 50;
    const offset = (Number(page) - 1) * limit;

    const query = db('sync_logs')
      .leftJoin('account_groups', 'sync_logs.group_id', 'account_groups.id')
      .select('sync_logs.*', 'account_groups.name as group_name');

    if (group_id) query.where('sync_logs.group_id', group_id);
    if (level) query.where('sync_logs.level', level);

    const logs = await query.orderBy('sync_logs.created_at', 'desc').limit(limit).offset(offset);
    const groups = await db('account_groups').orderBy('id');

    const [{ count }] = await db('sync_logs')
      .modify((qb: any) => {
        if (group_id) qb.where('group_id', group_id);
        if (level) qb.where('level', level);
      })
      .count('* as count');

    res.render('logs', {
      logs,
      groups,
      filters: { group_id, level },
      pagination: {
        page: Number(page),
        totalPages: Math.ceil(Number(count) / limit),
        total: Number(count),
      },
    });
  } catch (err: any) {
    res.status(500).send(`Error loading logs: ${err.message}`);
  }
});

export default router;
