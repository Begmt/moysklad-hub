import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  const hasColumn = await knex.schema.hasColumn('document_links', 'source_document_type');

  if (!hasColumn) {
    await knex.schema.alterTable('document_links', (table) => {
      table.string('source_document_type', 50).notNullable().defaultTo('demand');
    });
  }

  await knex.raw('ALTER TABLE document_links DROP CONSTRAINT IF EXISTS document_links_source_demand_uuid_unique');
  await knex.raw('DROP INDEX IF EXISTS document_links_source_document_type_source_demand_uuid_unique');

  await knex.schema.alterTable('document_links', (table) => {
    table.unique(['source_document_type', 'source_demand_uuid']);
    table.index(['source_document_type', 'source_demand_uuid']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE document_links DROP CONSTRAINT IF EXISTS document_links_source_document_type_source_demand_uuid_unique');
  await knex.raw('DROP INDEX IF EXISTS document_links_source_document_type_source_demand_uuid_index');

  const hasColumn = await knex.schema.hasColumn('document_links', 'source_document_type');
  if (hasColumn) {
    await knex.schema.alterTable('document_links', (table) => {
      table.dropColumn('source_document_type');
    });
  }

  await knex.schema.alterTable('document_links', (table) => {
    table.unique(['source_demand_uuid']);
  });
}
