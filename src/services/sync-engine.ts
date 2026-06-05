import { db } from '../config/database';
import { env } from '../config/env';
import { MoySkladClient } from './moysklad-client';
import { Logger } from './logger';

interface DemandPosition {
  assortment: {
    meta: { href: string };
    code?: string;
    article?: string;
    name: string;
  };
  quantity: number;
  price: number;
}

interface RouteRecord {
  id: number;
  source_account_id: number;
  agent_uuid: string;
  target_account_id: number;
  target_agent_uuid: string;
  target_organization_uuid: string;
  target_store_uuid: string;
  is_active: boolean;
}

interface AccountRecord {
  id: number;
  group_id: number | null;
  ms_account_id: string;
  name: string;
  api_token: string;
}

type SupportedDocumentType = 'demand' | 'purchasereturn';

export class SyncEngine {
  async processDocumentWebhook(accountMsId: string, documentType: string, documentId: string): Promise<void> {
    if (documentType === 'purchasereturn') {
      await this.processPurchaseReturnWebhook(accountMsId, documentId);
      return;
    }

    if (documentType === 'demand') {
      await this.processDemandWebhook(accountMsId, documentId);
      return;
    }

    await Logger.warning(`Unsupported document type ignored: ${documentType}`, undefined, {
      accountMsId,
      documentType,
      documentId,
    });
  }

  /**
   * Main entry point: processes a Demand webhook
   */
  async processDemandWebhook(accountMsId: string, demandId: string): Promise<void> {
    // 1. Find source account
    const sourceAccount = await db('accounts')
      .where('ms_account_id', accountMsId)
      .first() as AccountRecord | undefined;

    if (!sourceAccount) {
      await Logger.error(`Unknown account: ${accountMsId}`, undefined, { accountMsId, demandId });
      return;
    }

    const sourceClient = new MoySkladClient(sourceAccount.api_token, sourceAccount.id);
    let demand: any;

    try {
      demand = await sourceClient.getDemand(demandId);
    } catch (err: any) {
      await Logger.error(
        `Failed to fetch demand ${demandId} from account "${sourceAccount.name}"`,
        sourceAccount.group_id ?? undefined,
        { error: err.message, demandId }
      );
      return;
    }

    // 2. Loop Check — prevent infinite loops
    if (demand.description && demand.description.includes('[Autosync-ID:')) {
      await Logger.info(
        `Skipping demand ${demandId}: loop detected (Autosync-ID present)`,
        sourceAccount.group_id ?? undefined
      );
      return;
    }

    // 3. Status Check: if a target state is configured, require it.
    // Otherwise process only posted/applicable documents and skip drafts.
    const demandState = demand.state?.name || '';
    const targetDemandState = env.ms.targetDemandState.trim();

    if (targetDemandState && demandState !== targetDemandState) {
      await Logger.info(
        `Skipping demand ${demandId}: status "${demandState}" is not target status "${targetDemandState}"`,
        sourceAccount.group_id ?? undefined,
        { currentStatus: demandState, targetDemandState, applicable: demand.applicable }
      );
      return;
    }

    if (!targetDemandState && demand.applicable !== true) {
      await Logger.info(
        `Skipping demand ${demandId}: document is not posted/applicable`,
        sourceAccount.group_id ?? undefined,
        { currentStatus: demandState, applicable: demand.applicable }
      );
      return;
    }

    // 4. Extract agent UUID from demand
    const agentMeta = demand.agent?.meta?.href || '';
    const agentUuid = agentMeta.split('/').pop() || '';

    if (!agentUuid) {
      await Logger.error(
        `Cannot extract agent UUID from demand ${demandId}`,
        sourceAccount.group_id ?? undefined,
        { demandId, agentMeta }
      );
      return;
    }

    // 5. Find route
    const route = await db('routes')
      .where({
        source_account_id: sourceAccount.id,
        agent_uuid: agentUuid,
        is_active: true,
      })
      .first() as RouteRecord | undefined;

    if (!route) {
      await Logger.info(
        `No active route found for agent ${agentUuid} from account "${sourceAccount.name}"`,
        sourceAccount.group_id ?? undefined,
        { agentUuid, sourceAccountId: sourceAccount.id }
      );
      return;
    }

    // 6. Group isolation enforcement
    const targetAccount = await db('accounts')
      .where('id', route.target_account_id)
      .first() as AccountRecord | undefined;

    if (!targetAccount) {
      await Logger.error(
        `Target account ${route.target_account_id} not found`,
        sourceAccount.group_id ?? undefined
      );
      return;
    }

    if (!sourceAccount.group_id || !targetAccount.group_id || sourceAccount.group_id !== targetAccount.group_id) {
      await Logger.error(
        `GROUP ISOLATION VIOLATION: Source "${sourceAccount.name}" (group ${sourceAccount.group_id}) ` +
        `tried to route to "${targetAccount.name}" (group ${targetAccount.group_id})`,
        sourceAccount.group_id ?? undefined,
        {
          sourceAccountId: sourceAccount.id,
          sourceGroupId: sourceAccount.group_id,
          targetAccountId: targetAccount.id,
          targetGroupId: targetAccount.group_id,
          demandId,
        }
      );
      return;
    }

    // 7. Fetch positions and resolve articles in target account
    const targetClient = new MoySkladClient(targetAccount.api_token, targetAccount.id);
    let positionsResponse: any;

    try {
      positionsResponse = await sourceClient.getDemandPositions(demandId);
    } catch (err: any) {
      await Logger.error(
        `Failed to fetch positions for demand ${demandId}`,
        sourceAccount.group_id ?? undefined,
        { error: err.message }
      );
      return;
    }

    const positions: DemandPosition[] = positionsResponse.rows || [];
    const enterPositions: any[] = [];
    const missingArticles: string[] = [];

    for (const pos of positions) {
      const article = pos.assortment?.code || pos.assortment?.article || '';

      if (!article) {
        missingArticles.push(pos.assortment?.name || 'Unknown product (no article)');
        continue;
      }

      try {
        const searchResult = await targetClient.findProductByArticle(article);
        const targetProduct = searchResult.rows?.[0];

        if (!targetProduct) {
          missingArticles.push(`${pos.assortment.name} (code: ${article})`);
          continue;
        }

        enterPositions.push({
          quantity: pos.quantity,
          price: pos.price,
          assortment: {
            meta: targetProduct.meta,
          },
        });
      } catch (err: any) {
        await Logger.error(
          `Failed to resolve article "${article}" in target account "${targetAccount.name}"`,
          sourceAccount.group_id ?? undefined,
          { error: err.message, article }
        );
        missingArticles.push(`${pos.assortment.name} (code: ${article}) [API Error]`);
      }
    }

    // 8. Block if any products are missing
    if (missingArticles.length > 0) {
      await Logger.error(
        `BLOCKED: ${missingArticles.length} product(s) not found in target account "${targetAccount.name}". ` +
        `Cannot create Supply document.`,
        sourceAccount.group_id ?? undefined,
        {
          missingProducts: missingArticles,
          demandId,
          sourceAccount: sourceAccount.name,
          targetAccount: targetAccount.name,
        }
      );
      return;
    }

    if (enterPositions.length === 0) {
      await Logger.warning(
        `No positions to sync for demand ${demandId}`,
        sourceAccount.group_id ?? undefined
      );
      return;
    }

    if (!route.target_agent_uuid) {
      await Logger.error(
        `Route ${route.id} is missing target supplier counterparty. Cannot create Supply document.`,
        sourceAccount.group_id ?? undefined,
        { routeId: route.id, demandId }
      );
      return;
    }

    // 9. Build Supply document
    const supplyBody = {
      applicable: false,
      agent: {
        meta: {
          href: targetClient.metaHref('counterparty', route.target_agent_uuid),
          type: 'counterparty',
          mediaType: 'application/json',
        },
      },
      organization: {
        meta: {
          href: targetClient.metaHref('organization', route.target_organization_uuid),
          type: 'organization',
          mediaType: 'application/json',
        },
      },
      store: {
        meta: {
          href: targetClient.metaHref('store', route.target_store_uuid),
          type: 'store',
          mediaType: 'application/json',
        },
      },
      description: `[Autosync-ID: ${demandId}] Synced from "${sourceAccount.name}" demand`,
      positions: enterPositions,
    };

    // 10. Check for existing link — update or create
    const existingLink = await db('document_links')
      .where({
        source_document_type: 'demand',
        source_demand_uuid: demandId,
      })
      .first();

    try {
      if (existingLink) {
        // Update existing Supply
        await targetClient.updateSupply(existingLink.target_enter_uuid, supplyBody);

        await db('document_links')
          .where({
            source_document_type: 'demand',
            source_demand_uuid: demandId,
          })
          .update({ updated_at: db.fn.now() });

        await Logger.info(
          `Updated Supply ${existingLink.target_enter_uuid} in "${targetAccount.name}" from demand ${demandId}`,
          sourceAccount.group_id ?? undefined,
          {
            demandId,
            enterId: existingLink.target_enter_uuid,
            positionCount: enterPositions.length,
          }
        );
      } else {
        // Create new Supply
        const newSupply = await targetClient.createSupply(supplyBody);
        const supplyId = newSupply.id;

        await db('document_links').insert({
          source_document_type: 'demand',
          source_demand_uuid: demandId,
          target_enter_uuid: supplyId,
          source_account_id: sourceAccount.id,
          target_account_id: targetAccount.id,
        });

        await Logger.info(
          `Created Supply ${supplyId} in "${targetAccount.name}" from demand ${demandId}`,
          sourceAccount.group_id ?? undefined,
          {
            demandId,
            supplyId,
            positionCount: enterPositions.length,
          }
        );
      }
    } catch (err: any) {
      await Logger.error(
        `Failed to create/update Supply in "${targetAccount.name}"`,
        sourceAccount.group_id ?? undefined,
        {
          error: err.message,
          responseData: err.response?.data,
          demandId,
        }
      );
    }
  }

  /**
   * Processes a supplier return from the receiving account and creates a draft Supply
   * back in the original sending account.
   */
  async processPurchaseReturnWebhook(accountMsId: string, purchaseReturnId: string): Promise<void> {
    const sourceAccount = await db('accounts')
      .where('ms_account_id', accountMsId)
      .first() as AccountRecord | undefined;

    if (!sourceAccount) {
      await Logger.error(`Unknown account: ${accountMsId}`, undefined, { accountMsId, purchaseReturnId });
      return;
    }

    const sourceClient = new MoySkladClient(sourceAccount.api_token, sourceAccount.id);
    let purchaseReturn: any;

    try {
      purchaseReturn = await sourceClient.getPurchaseReturn(purchaseReturnId);
    } catch (err: any) {
      await Logger.error(
        `Failed to fetch purchasereturn ${purchaseReturnId} from account "${sourceAccount.name}"`,
        sourceAccount.group_id ?? undefined,
        { error: err.message, responseData: err.response?.data, purchaseReturnId }
      );
      return;
    }

    if (purchaseReturn.description && purchaseReturn.description.includes('[Autosync-ID:')) {
      await Logger.info(
        `Skipping purchasereturn ${purchaseReturnId}: loop detected (Autosync-ID present)`,
        sourceAccount.group_id ?? undefined
      );
      return;
    }

    if (purchaseReturn.applicable !== true) {
      await Logger.info(
        `Skipping purchasereturn ${purchaseReturnId}: document is not posted/applicable`,
        sourceAccount.group_id ?? undefined,
        { applicable: purchaseReturn.applicable }
      );
      return;
    }

    const agentMeta = purchaseReturn.agent?.meta?.href || '';
    const agentUuid = agentMeta.split('/').pop() || '';

    if (!agentUuid) {
      await Logger.error(
        `Cannot extract agent UUID from purchasereturn ${purchaseReturnId}`,
        sourceAccount.group_id ?? undefined,
        { purchaseReturnId, agentMeta }
      );
      return;
    }

    const route = await db('routes')
      .where({
        target_account_id: sourceAccount.id,
        target_agent_uuid: agentUuid,
        is_active: true,
      })
      .first() as RouteRecord | undefined;

    if (!route) {
      await Logger.info(
        `No reverse route found for supplier ${agentUuid} from account "${sourceAccount.name}"`,
        sourceAccount.group_id ?? undefined,
        { agentUuid, sourceAccountId: sourceAccount.id, purchaseReturnId }
      );
      return;
    }

    const targetAccount = await db('accounts')
      .where('id', route.source_account_id)
      .first() as AccountRecord | undefined;

    if (!targetAccount) {
      await Logger.error(
        `Reverse target account ${route.source_account_id} not found`,
        sourceAccount.group_id ?? undefined
      );
      return;
    }

    if (!sourceAccount.group_id || !targetAccount.group_id || sourceAccount.group_id !== targetAccount.group_id) {
      await Logger.error(
        `GROUP ISOLATION VIOLATION: Return source "${sourceAccount.name}" (group ${sourceAccount.group_id}) ` +
        `tried to route to "${targetAccount.name}" (group ${targetAccount.group_id})`,
        sourceAccount.group_id ?? undefined,
        {
          sourceAccountId: sourceAccount.id,
          sourceGroupId: sourceAccount.group_id,
          targetAccountId: targetAccount.id,
          targetGroupId: targetAccount.group_id,
          purchaseReturnId,
        }
      );
      return;
    }

    const relatedSupplyIds = this.extractRelatedSupplyIds(purchaseReturn);
    let originalLink: any;

    if (relatedSupplyIds.length > 0) {
      originalLink = await db('document_links')
        .whereIn('target_enter_uuid', relatedSupplyIds)
        .andWhere('source_document_type', 'demand')
        .first();
    }

    if (!originalLink) {
      await Logger.error(
        `Cannot sync purchasereturn ${purchaseReturnId}: linked autosync Supply was not found. Create the return from the synced Supply document.`,
        sourceAccount.group_id ?? undefined,
        { purchaseReturnId, relatedSupplyIds }
      );
      return;
    }

    const targetClient = new MoySkladClient(targetAccount.api_token, targetAccount.id);
    let originalDemand: any;
    let positionsResponse: any;

    try {
      originalDemand = await targetClient.getDemand(originalLink.source_demand_uuid);
      positionsResponse = await sourceClient.getPurchaseReturnPositions(purchaseReturnId);
    } catch (err: any) {
      await Logger.error(
        `Failed to fetch source data for purchasereturn ${purchaseReturnId}`,
        sourceAccount.group_id ?? undefined,
        { error: err.message, responseData: err.response?.data, purchaseReturnId }
      );
      return;
    }

    const targetOrganizationUuid = this.extractUuid(originalDemand.organization?.meta?.href);
    const targetStoreUuid = this.extractUuid(originalDemand.store?.meta?.href);

    if (!targetOrganizationUuid || !targetStoreUuid) {
      await Logger.error(
        `Cannot extract target organization/store from original demand ${originalLink.source_demand_uuid}`,
        sourceAccount.group_id ?? undefined,
        { originalDemandId: originalLink.source_demand_uuid, purchaseReturnId }
      );
      return;
    }

    const positions: DemandPosition[] = positionsResponse.rows || [];
    const supplyPositions: any[] = [];
    const missingArticles: string[] = [];

    for (const pos of positions) {
      const article = pos.assortment?.code || pos.assortment?.article || '';

      if (!article) {
        missingArticles.push(pos.assortment?.name || 'Unknown product (no article)');
        continue;
      }

      try {
        const searchResult = await targetClient.findProductByArticle(article);
        const targetProduct = searchResult.rows?.[0];

        if (!targetProduct) {
          missingArticles.push(`${pos.assortment.name} (code: ${article})`);
          continue;
        }

        supplyPositions.push({
          quantity: pos.quantity,
          price: pos.price,
          assortment: {
            meta: targetProduct.meta,
          },
        });
      } catch (err: any) {
        await Logger.error(
          `Failed to resolve return article "${article}" in target account "${targetAccount.name}"`,
          sourceAccount.group_id ?? undefined,
          { error: err.message, article }
        );
        missingArticles.push(`${pos.assortment.name} (code: ${article}) [API Error]`);
      }
    }

    if (missingArticles.length > 0) {
      await Logger.error(
        `BLOCKED: ${missingArticles.length} returned product(s) not found in target account "${targetAccount.name}". ` +
        `Cannot create reverse Supply document.`,
        sourceAccount.group_id ?? undefined,
        {
          missingProducts: missingArticles,
          purchaseReturnId,
          sourceAccount: sourceAccount.name,
          targetAccount: targetAccount.name,
        }
      );
      return;
    }

    if (supplyPositions.length === 0) {
      await Logger.warning(
        `No positions to sync for purchasereturn ${purchaseReturnId}`,
        sourceAccount.group_id ?? undefined
      );
      return;
    }

    const supplyBody = {
      applicable: false,
      agent: {
        meta: {
          href: targetClient.metaHref('counterparty', route.agent_uuid),
          type: 'counterparty',
          mediaType: 'application/json',
        },
      },
      organization: {
        meta: {
          href: targetClient.metaHref('organization', targetOrganizationUuid),
          type: 'organization',
          mediaType: 'application/json',
        },
      },
      store: {
        meta: {
          href: targetClient.metaHref('store', targetStoreUuid),
          type: 'store',
          mediaType: 'application/json',
        },
      },
      description: `[Autosync-ID: ${purchaseReturnId}] Synced from "${sourceAccount.name}" supplier return`,
      positions: supplyPositions,
    };

    const existingLink = await db('document_links')
      .where({
        source_document_type: 'purchasereturn',
        source_demand_uuid: purchaseReturnId,
      })
      .first();

    try {
      if (existingLink) {
        await targetClient.updateSupply(existingLink.target_enter_uuid, supplyBody);

        await db('document_links')
          .where({
            source_document_type: 'purchasereturn',
            source_demand_uuid: purchaseReturnId,
          })
          .update({ updated_at: db.fn.now() });

        await Logger.info(
          `Updated reverse Supply ${existingLink.target_enter_uuid} in "${targetAccount.name}" from purchasereturn ${purchaseReturnId}`,
          sourceAccount.group_id ?? undefined,
          {
            purchaseReturnId,
            supplyId: existingLink.target_enter_uuid,
            positionCount: supplyPositions.length,
          }
        );
      } else {
        const newSupply = await targetClient.createSupply(supplyBody);
        const supplyId = newSupply.id;

        await db('document_links').insert({
          source_document_type: 'purchasereturn',
          source_demand_uuid: purchaseReturnId,
          target_enter_uuid: supplyId,
          source_account_id: sourceAccount.id,
          target_account_id: targetAccount.id,
        });

        await Logger.info(
          `Created reverse Supply ${supplyId} in "${targetAccount.name}" from purchasereturn ${purchaseReturnId}`,
          sourceAccount.group_id ?? undefined,
          {
            purchaseReturnId,
            supplyId,
            positionCount: supplyPositions.length,
          }
        );
      }
    } catch (err: any) {
      await Logger.error(
        `Failed to create/update reverse Supply in "${targetAccount.name}"`,
        sourceAccount.group_id ?? undefined,
        {
          error: err.message,
          responseData: err.response?.data,
          purchaseReturnId,
        }
      );
    }
  }

  private extractUuid(href?: string): string {
    return href ? String(href).split('/').pop() || '' : '';
  }

  private extractRelatedSupplyIds(document: any): string[] {
    const ids = new Set<string>();
    const addHref = (href?: string) => {
      const match = href ? String(href).match(/\/entity\/supply\/([^/?#]+)/) : null;
      if (match?.[1]) ids.add(match[1]);
    };

    addHref(document?.supply?.meta?.href);
    addHref(document?.supply?.href);

    const collections = [
      document?.supplies,
      document?.supplies?.rows,
      document?.documents,
      document?.documents?.rows,
    ];

    for (const collection of collections) {
      if (!Array.isArray(collection)) continue;
      for (const item of collection) {
        addHref(item?.meta?.href);
        addHref(item?.href);
      }
    }

    return Array.from(ids);
  }
}
