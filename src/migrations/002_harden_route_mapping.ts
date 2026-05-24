import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  const hasTargetAgent = await knex.schema.hasColumn('routes', 'target_agent_uuid');
  if (!hasTargetAgent) {
    await knex.schema.alterTable('routes', (table) => {
      table.string('target_agent_uuid', 255);
    });
  }

  const accountsWithNoGroup = await knex('accounts').whereNull('group_id').count('* as count').first();
  if (Number(accountsWithNoGroup?.count || 0) > 0) {
    const [group] = await knex('account_groups')
      .insert({ name: 'Unassigned migration group' })
      .returning('*');

    await knex('accounts').whereNull('group_id').update({ group_id: group.id });
  }

  await knex.schema.alterTable('accounts', (table) => {
    table.dropForeign(['group_id']);
  });

  await knex.schema.alterTable('accounts', (table) => {
    table.integer('group_id').notNullable().alter();
  });

  await knex.schema.alterTable('accounts', (table) => {
    table.foreign('group_id').references('id').inTable('account_groups').onDelete('RESTRICT');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('accounts', (table) => {
    table.dropForeign(['group_id']);
  });

  await knex.schema.alterTable('accounts', (table) => {
    table.integer('group_id').nullable().alter();
  });

  await knex.schema.alterTable('accounts', (table) => {
    table.foreign('group_id').references('id').inTable('account_groups').onDelete('SET NULL');
  });

  const hasTargetAgent = await knex.schema.hasColumn('routes', 'target_agent_uuid');
  if (hasTargetAgent) {
    await knex.schema.alterTable('routes', (table) => {
      table.dropColumn('target_agent_uuid');
    });
  }
}
