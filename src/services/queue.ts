import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { env } from '../config/env';
import { SyncEngine } from './sync-engine';
import { Logger } from './logger';

const connection = new IORedis({
  host: env.redis.host,
  port: env.redis.port,
  password: env.redis.password,
  maxRetriesPerRequest: null,
});

export const syncQueue = new Queue('demand-sync', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
});

export function startWorker(): Worker {
  const syncEngine = new SyncEngine();

  const worker = new Worker(
    'demand-sync',
    async (job: Job) => {
      const { accountMsId, demandId } = job.data;
      await Logger.info(`Processing job ${job.id}: demand ${demandId} from account ${accountMsId}`);
      await syncEngine.processDemandWebhook(accountMsId, demandId);
    },
    {
      connection,
      concurrency: 2,
      limiter: {
        max: 5,
        duration: 1000,
      },
    }
  );

  worker.on('completed', (job) => {
    Logger.info(`Job ${job.id} completed successfully`);
  });

  worker.on('failed', (job, err) => {
    Logger.error(`Job ${job?.id} failed: ${err.message}`, undefined, {
      jobId: job?.id,
      error: err.message,
      data: job?.data,
    });
  });

  console.log('[Queue] Worker started, listening for demand-sync jobs...');
  return worker;
}
