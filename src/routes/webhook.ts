import { Router, Request, Response } from 'express';
import { syncQueue } from '../services/queue';
import { Logger } from '../services/logger';

const router = Router();

async function enqueueDemand(accountMsId: string, demandId: string): Promise<void> {
  await syncQueue.add(
    `sync-${accountMsId}-${demandId}`,
    { accountMsId, demandId },
    {
      jobId: `${accountMsId}:${demandId}:${Date.now()}`,
    }
  );
}

/**
 * GET /api/webhook/:accountMsId?id=:demandId
 * Simple scenario webhook URL for MoySklad UI.
 */
router.get('/:accountMsId', async (req: Request, res: Response) => {
  try {
    const accountMsId = String(req.params.accountMsId);
    const demandId = String(req.query.id || req.query.demandId || '').trim();

    if (!demandId) {
      res.status(400).json({ error: 'Query parameter id is required' });
      return;
    }

    await enqueueDemand(accountMsId, demandId);
    await Logger.info('Scenario webhook received: 1 demand enqueued', undefined, {
      accountMsId,
      demandId,
      query: req.query,
    });

    res.status(200).json({ ok: true, enqueued: 1 });
  } catch (err: any) {
    await Logger.error(`Scenario webhook processing error: ${err.message}`, undefined, {
      error: err.message,
      query: req.query,
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/webhook/:accountMsId
 * MoySklad sends Demand webhook events here.
 * Each account has its own webhook URL identified by accountMsId.
 */
router.post('/:accountMsId', async (req: Request, res: Response) => {
  try {
    const accountMsId = String(req.params.accountMsId);
    const events = req.body;

    if (!Array.isArray(events)) {
      res.status(400).json({ error: 'Expected array of webhook events' });
      return;
    }

    let enqueued = 0;

    for (const event of events) {
      // Only process Demand events
      if (event.meta?.type !== 'demand') continue;

      // Extract demand UUID from meta.href
      const href: string = event.meta?.href || '';
      const demandId = href.split('/').pop();

      if (!demandId) {
        await Logger.warning('Webhook event missing demand ID', undefined, { event });
        continue;
      }

      // Only process UPDATE and CREATE actions
      const action = event.action;
      if (action !== 'UPDATE' && action !== 'CREATE') continue;

      await enqueueDemand(accountMsId, demandId);
      enqueued++;
    }

    await Logger.info(
      `Webhook received: ${events.length} events, ${enqueued} demand(s) enqueued`,
      undefined,
      { accountMsId, totalEvents: events.length, enqueued }
    );

    res.status(200).json({ ok: true, enqueued });
  } catch (err: any) {
    await Logger.error(`Webhook processing error: ${err.message}`, undefined, {
      error: err.message,
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
