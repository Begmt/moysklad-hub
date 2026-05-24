import axios, { AxiosInstance, AxiosError } from 'axios';
import { env } from '../config/env';
import { Logger } from './logger';

interface RateLimitState {
  tokens: number;
  lastRefill: number;
}

const accountRateLimits = new Map<number, RateLimitState>();

function getRateLimitState(accountId: number): RateLimitState {
  if (!accountRateLimits.has(accountId)) {
    accountRateLimits.set(accountId, {
      tokens: env.ms.rateLimitPer200ms,
      lastRefill: Date.now(),
    });
  }
  return accountRateLimits.get(accountId)!;
}

async function waitForToken(accountId: number): Promise<void> {
  const state = getRateLimitState(accountId);
  const now = Date.now();
  const elapsed = now - state.lastRefill;

  if (elapsed >= 200) {
    state.tokens = env.ms.rateLimitPer200ms;
    state.lastRefill = now;
  }

  if (state.tokens > 0) {
    state.tokens--;
    return;
  }

  const waitTime = 200 - elapsed;
  await new Promise((resolve) => setTimeout(resolve, waitTime));
  state.tokens = env.ms.rateLimitPer200ms - 1;
  state.lastRefill = Date.now();
}

export class MoySkladClient {
  private client: AxiosInstance;
  private accountId: number;
  private maxRetries = 5;

  constructor(apiToken: string, accountId: number) {
    this.accountId = accountId;
    this.client = axios.create({
      baseURL: env.ms.apiBaseUrl,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
        'Accept-Encoding': 'gzip',
      },
      timeout: 30000,
    });
  }

  private async requestWithRetry<T>(method: 'get' | 'post' | 'put', url: string, data?: unknown): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      await waitForToken(this.accountId);

      try {
        const response = method === 'get'
          ? await this.client.get<T>(url)
          : method === 'post'
            ? await this.client.post<T>(url, data)
            : await this.client.put<T>(url, data);
        return response.data;
      } catch (err) {
        const axiosErr = err as AxiosError;
        if (axiosErr.response?.status === 429) {
          const backoff = Math.min(1000 * Math.pow(2, attempt), 16000);
          await Logger.warning(
            `Rate limited (429) on account ${this.accountId}, retry ${attempt + 1}, waiting ${backoff}ms`,
            undefined,
            { accountId: this.accountId, attempt, url }
          );
          await new Promise((resolve) => setTimeout(resolve, backoff));
          lastError = axiosErr;
          continue;
        }
        throw err;
      }
    }

    throw lastError || new Error('Max retries exceeded');
  }

  async getDemand(demandId: string): Promise<any> {
    return this.requestWithRetry('get', `/entity/demand/${demandId}?expand=positions.assortment,agent`);
  }

  async getDemandPositions(demandId: string): Promise<any> {
    return this.requestWithRetry('get', `/entity/demand/${demandId}/positions?expand=assortment&limit=100`);
  }

  async findProductByArticle(article: string): Promise<any> {
    return this.requestWithRetry('get', `/entity/assortment?filter=code=${encodeURIComponent(article)}&limit=1`);
  }

  async createSupply(supplyData: any): Promise<any> {
    return this.requestWithRetry('post', '/entity/supply', supplyData);
  }

  async updateSupply(supplyId: string, supplyData: any): Promise<any> {
    return this.requestWithRetry('put', `/entity/supply/${supplyId}`, supplyData);
  }

  async getCounterparties(search?: string): Promise<any> {
    const searchParam = search ? `&search=${encodeURIComponent(search)}` : '';
    return this.requestWithRetry('get', `/entity/counterparty?limit=100${searchParam}`);
  }

  async getOrganizations(): Promise<any> {
    return this.requestWithRetry('get', '/entity/organization?limit=100');
  }

  async getStores(): Promise<any> {
    return this.requestWithRetry('get', '/entity/store?limit=100');
  }

  async getAccountInfo(): Promise<any> {
    return this.requestWithRetry('get', '/context/employee');
  }

  metaHref(entity: string, uuid: string): string {
    return `${this.client.defaults.baseURL}/entity/${entity}/${uuid}`;
  }
}
