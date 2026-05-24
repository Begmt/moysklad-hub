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

function asEventList(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.events)) return payload.events;
  if (Array.isArray(payload?.rows)) return payload.rows;
  if (payload && typeof payload === 'object') return [payload];
  return [];
}

function extractDemandId(event: any): string | null {
  const hrefs = [
    event?.meta?.href,
    event?.href,
    event?.entity?.meta?.href,
    event?.object?.meta?.href,
    event?.entityHref,
  ].filter(Boolean);

  for (const href of hrefs) {
    const match = String(href).match(/\/entity\/demand\/([^/?#]+)/);
    if (match?.[1]) return match[1];
  }

  if (event?.entityType === 'demand' && event?.entityId) return String(event.entityId);
  if (event?.meta?.type === 'demand' && event?.id) return String(event.id);
  return null;
}

function isDemandEvent(event: any): boolean {
  if (event?.meta?.type === 'demand' || event?.entityType === 'demand') return true;
  return Boolean(extractDemandId(event));
}

function shouldProcessAction(event: any): boolean {
  const action = event?.action || event?.actionType;
  return !action || action === 'UPDATE' || action === 'CREATE';
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
    const events = asEventList(req.body);

    let enqueued = 0;

    for (const event of events) {
      if (!isDemandEvent(event)) continue;
      if (!shouldProcessAction(event)) continue;
      const demandId = extractDemandId(event);
      if (!demandId) {
        await Logger.warning('Webhook event missing demand ID', undefined, { event });
        continue;
      }

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
