import { Router, Request, Response } from 'express';
import { db } from '../config/database';
import { env } from '../config/env';
import { Logger } from '../services/logger';
import { MoySkladClient } from '../services/moysklad-client';

const router = Router();

function toDirectoryRows(response: any) {
  return (response.rows || []).map((row: any) => ({
    id: row.id,
    name: row.name,
    code: row.code,
    archived: row.archived,
    meta: row.meta,
  }));
}

async function getAccountClient(accountId: string | number): Promise<MoySkladClient | null> {
  const account = await db('accounts').where('id', accountId).first();
  if (!account) return null;
  return new MoySkladClient(account.api_token, account.id);
}

function getMoySkladError(err: any) {
  return err.response?.data || err.message || 'Unknown MoySklad API error';
}

// ===================== GROUPS =====================

router.get('/groups', async (_req: Request, res: Response) => {
  try {
    const groups = await db('account_groups').orderBy('id');
    res.json(groups);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/groups', async (req: Request, res: Response) => {
  try {
    const { name } = req.body;
    if (!name) {
      res.status(400).json({ error: 'Name is required' });
      return;
    }
    const [group] = await db('account_groups').insert({ name }).returning('*');
    await Logger.info(`Group created: "${name}"`, group.id);
    res.status(201).json(group);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/groups/:id', async (req: Request, res: Response) => {
  try {
    const { name } = req.body;
    const [group] = await db('account_groups')
      .where('id', req.params.id)
      .update({ name })
      .returning('*');
    res.json(group);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/groups/:id', async (req: Request, res: Response) => {
  try {
    await db('account_groups').where('id', req.params.id).del();
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ===================== ACCOUNTS =====================

router.get('/accounts', async (req: Request, res: Response) => {
  try {
    const query = db('accounts')
      .leftJoin('account_groups', 'accounts.group_id', 'account_groups.id')
      .select('accounts.*', 'account_groups.name as group_name');

    if (req.query.group_id) {
      query.where('accounts.group_id', req.query.group_id);
    }

    const accounts = await query.orderBy('accounts.id');
    // Mask tokens
    accounts.forEach((a: any) => {
      a.api_token_masked = a.api_token ? `${a.api_token.substring(0, 8)}...` : '';
      delete a.api_token;
    });
    res.json(accounts);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/accounts', async (req: Request, res: Response) => {
  try {
    const { group_id, ms_account_id, name, api_token } = req.body;
    if (!group_id || !ms_account_id || !name || !api_token) {
      res.status(400).json({ error: 'group_id, ms_account_id, name, and api_token are required' });
      return;
    }

    const group = await db('account_groups').where('id', group_id).first();
    if (!group) {
      res.status(400).json({ error: 'Selected group does not exist' });
      return;
    }

    const [account] = await db('accounts')
      .insert({ group_id, ms_account_id, name, api_token })
      .returning('*');
    await Logger.info(`Account connected: "${name}"`, group_id);
    res.status(201).json({ ...account, api_token: undefined });
  } catch (err: any) {
    if (err.code === '23505') {
      res.status(409).json({ error: 'Account with this MS Account ID already exists' });
      return;
    }
    res.status(500).json({ error: err.message });
  }
});

router.put('/accounts/:id', async (req: Request, res: Response) => {
  try {
    const { group_id, name, api_token } = req.body;
    const updates: any = {};
    if (name !== undefined) updates.name = name;
    if (group_id !== undefined) {
      if (!group_id) {
        res.status(400).json({ error: 'Account group is required' });
        return;
      }

      const existing = await db('accounts').where('id', req.params.id).first();
      if (!existing) {
        res.status(404).json({ error: 'Account not found' });
        return;
      }

      if (Number(existing.group_id) !== Number(group_id)) {
        const routeCount = await db('routes')
          .where('source_account_id', req.params.id)
          .orWhere('target_account_id', req.params.id)
          .count('* as count')
          .first();

        if (Number(routeCount?.count || 0) > 0) {
          res.status(400).json({
            error: 'Cannot change account group while routes exist for this account',
          });
          return;
        }
      }

      updates.group_id = group_id;
    }
    if (api_token) updates.api_token = api_token;

    const [account] = await db('accounts')
      .where('id', req.params.id)
      .update(updates)
      .returning('*');
    res.json({ ...account, api_token: undefined });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/accounts/:id', async (req: Request, res: Response) => {
  try {
    await db('accounts').where('id', req.params.id).del();
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/accounts/:id/webhooks/demand', async (req: Request, res: Response) => {
  try {
    const account = await db('accounts').where('id', req.params.id).first();
    if (!account) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }

    const client = new MoySkladClient(account.api_token, account.id);
    const webhookUrl = `${env.publicBaseUrl}/api/webhook/${encodeURIComponent(account.ms_account_id)}`;
    const existing = await client.getWebhooks();
    const existingRows = existing.rows || [];
    const actions = ['CREATE', 'UPDATE'];
    const entityTypes = ['demand', 'purchasereturn'];
    const savedWebhooks = [];

    for (const entityType of entityTypes) {
      for (const action of actions) {
        const payload = {
          url: webhookUrl,
          action,
          entityType,
          enabled: true,
        };

        const current = existingRows.find((row: any) => row.entityType === entityType && row.action === action);
        if (current?.id) {
          savedWebhooks.push(await client.updateWebhook(current.id, payload));
        } else {
          savedWebhooks.push(await client.createWebhook(payload));
        }
      }
    }

    await Logger.info(`Document webhooks configured for account "${account.name}"`, account.group_id, {
      accountId: account.id,
      msAccountId: account.ms_account_id,
      webhookUrl,
      actions,
      entityTypes,
    });

    res.json({ ok: true, webhookUrl, webhooks: savedWebhooks });
  } catch (err: any) {
    const account = await db('accounts').where('id', req.params.id).first();
    await Logger.error(`Failed to configure document webhooks: ${JSON.stringify(getMoySkladError(err))}`, account?.group_id, {
      accountId: req.params.id,
      error: getMoySkladError(err),
    });
    res.status(500).json({ error: getMoySkladError(err) });
  }
});

// ===================== ROUTES =====================

router.get('/routes', async (req: Request, res: Response) => {
  try {
    const query = db('routes')
      .join('accounts as src', 'routes.source_account_id', 'src.id')
      .join('accounts as tgt', 'routes.target_account_id', 'tgt.id')
      .select(
        'routes.*',
        'src.name as source_account_name',
        'src.group_id as source_group_id',
        'tgt.name as target_account_name',
        'tgt.group_id as target_group_id'
      );

    if (req.query.group_id) {
      query.where('src.group_id', req.query.group_id);
    }

    const routes = await query.orderBy('routes.id');
    res.json(routes);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/routes', async (req: Request, res: Response) => {
  try {
    const {
      source_account_id,
      agent_uuid,
      target_account_id,
      target_agent_uuid,
      target_organization_uuid,
      target_store_uuid,
    } = req.body;

    if (
      !source_account_id ||
      !agent_uuid ||
      !target_account_id ||
      !target_agent_uuid ||
      !target_organization_uuid ||
      !target_store_uuid
    ) {
      res.status(400).json({
        error: 'source_account_id, agent_uuid, target_account_id, target_agent_uuid, target_organization_uuid, and target_store_uuid are required',
      });
      return;
    }

    // Validate same group
    const sourceAcc = await db('accounts').where('id', source_account_id).first();
    const targetAcc = await db('accounts').where('id', target_account_id).first();

    if (!sourceAcc || !targetAcc) {
      res.status(404).json({ error: 'Source or target account not found' });
      return;
    }

    if (!sourceAcc.group_id || !targetAcc.group_id || sourceAcc.group_id !== targetAcc.group_id) {
      res.status(400).json({
        error: 'Cannot create route between accounts in different groups',
      });
      return;
    }

    if (source_account_id === target_account_id) {
      res.status(400).json({ error: 'Cannot route to the same account' });
      return;
    }

    const [route] = await db('routes')
      .insert({
        source_account_id,
        agent_uuid,
        target_account_id,
        target_agent_uuid,
        target_organization_uuid,
        target_store_uuid,
      })
      .returning('*');

    await Logger.info(
      `Route created: ${sourceAcc.name} -> ${targetAcc.name}`,
      sourceAcc.group_id
    );
    res.status(201).json(route);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/routes/:id', async (req: Request, res: Response) => {
  try {
    const { agent_uuid, target_agent_uuid, target_organization_uuid, target_store_uuid, is_active } = req.body;
    const updates: any = {};
    if (agent_uuid !== undefined) updates.agent_uuid = agent_uuid;
    if (target_agent_uuid !== undefined) updates.target_agent_uuid = target_agent_uuid;
    if (target_organization_uuid !== undefined) updates.target_organization_uuid = target_organization_uuid;
    if (target_store_uuid !== undefined) updates.target_store_uuid = target_store_uuid;
    if (is_active !== undefined) updates.is_active = is_active;

    const [route] = await db('routes').where('id', req.params.id).update(updates).returning('*');
    res.json(route);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/routes/:id', async (req: Request, res: Response) => {
  try {
    await db('routes').where('id', req.params.id).del();
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ===================== LOGS =====================

router.get('/logs', async (req: Request, res: Response) => {
  try {
    const { group_id, level, limit = 100, offset = 0 } = req.query;

    const query = db('sync_logs').orderBy('created_at', 'desc');

    if (group_id) query.where('group_id', group_id);
    if (level) query.where('level', level);

    const logs = await query.limit(Number(limit)).offset(Number(offset));
    const [{ count }] = await db('sync_logs')
      .modify((qb: any) => {
        if (group_id) qb.where('group_id', group_id);
        if (level) qb.where('level', level);
      })
      .count('* as count');

    res.json({ logs, total: Number(count), limit: Number(limit), offset: Number(offset) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ===================== DOCUMENT LINKS =====================

router.get('/document-links', async (req: Request, res: Response) => {
  try {
    const links = await db('document_links')
      .leftJoin('accounts as src', 'document_links.source_account_id', 'src.id')
      .leftJoin('accounts as tgt', 'document_links.target_account_id', 'tgt.id')
      .select(
        'document_links.*',
        'src.name as source_account_name',
        'tgt.name as target_account_name'
      )
      .orderBy('document_links.updated_at', 'desc')
      .limit(100);
    res.json(links);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ===================== MOYSKLAD DIRECTORIES =====================

router.get('/moysklad/accounts/:id/counterparties', async (req: Request, res: Response) => {
  try {
    const client = await getAccountClient(String(req.params.id));
    if (!client) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }

    const response = await client.getCounterparties(String(req.query.search || ''));
    res.json(toDirectoryRows(response));
  } catch (err: any) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

router.get('/moysklad/accounts/:id/organizations', async (req: Request, res: Response) => {
  try {
    const client = await getAccountClient(String(req.params.id));
    if (!client) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }

    const response = await client.getOrganizations();
    res.json(toDirectoryRows(response));
  } catch (err: any) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

router.get('/moysklad/accounts/:id/stores', async (req: Request, res: Response) => {
  try {
    const client = await getAccountClient(String(req.params.id));
    if (!client) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }

    const response = await client.getStores();
    res.json(toDirectoryRows(response));
  } catch (err: any) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

export default router;
