import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // 1. Account Groups
  await knex.schema.createTable('account_groups', (table) => {
    table.increments('id').primary();
    table.string('name', 255).notNullable();
    table.timestamp('created_at').defaultTo(knex.fn.now());
  });

  // 2. Accounts
  await knex.schema.createTable('accounts', (table) => {
    table.increments('id').primary();
    table.integer('group_id').references('id').inTable('account_groups').onDelete('RESTRICT').notNullable();
    table.string('ms_account_id', 255).unique().notNullable();
    table.string('name', 255).notNullable();
    table.text('api_token').notNullable();
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.index('group_id');
  });

  // 3. Routes
  await knex.schema.createTable('routes', (table) => {
    table.increments('id').primary();
    table.integer('source_account_id').references('id').inTable('accounts').onDelete('CASCADE').notNullable();
    table.string('agent_uuid', 255).notNullable();
    table.integer('target_account_id').references('id').inTable('accounts').onDelete('CASCADE').notNullable();
    table.string('target_agent_uuid', 255).notNullable();
    table.string('target_organization_uuid', 255).notNullable();
    table.string('target_store_uuid', 255).notNullable();
    table.boolean('is_active').defaultTo(true);
    table.index(['source_account_id', 'agent_uuid']);
  });

  // 4. Document Links
  await knex.schema.createTable('document_links', (table) => {
    table.increments('id').primary();
    table.string('source_document_type', 50).notNullable().defaultTo('demand');
    table.string('source_demand_uuid', 255).notNullable();
    table.string('target_enter_uuid', 255).unique().notNullable();
    table.integer('source_account_id').references('id').inTable('accounts').onDelete('CASCADE');
    table.integer('target_account_id').references('id').inTable('accounts').onDelete('CASCADE');
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    table.unique(['source_document_type', 'source_demand_uuid']);
    table.index('source_demand_uuid');
    table.index(['source_document_type', 'source_demand_uuid']);
  });

  // 5. Sync Logs
  await knex.schema.createTable('sync_logs', (table) => {
    table.increments('id').primary();
    table.integer('group_id').references('id').inTable('account_groups').onDelete('CASCADE');
    table.string('level', 50).defaultTo('INFO');
    table.text('message').notNullable();
    table.jsonb('details');
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.index(['group_id', 'created_at']);
    table.index('level');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('sync_logs');
  await knex.schema.dropTableIfExists('document_links');
  await knex.schema.dropTableIfExists('routes');
  await knex.schema.dropTableIfExists('accounts');
  await knex.schema.dropTableIfExists('account_groups');
}
