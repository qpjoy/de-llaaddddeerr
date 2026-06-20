import type { MigrationInterface, QueryRunner } from 'typeorm';

export class LauncherNetworkLeaseConstraints1760000000100 implements MigrationInterface {
  name = 'LauncherNetworkLeaseConstraints1760000000100';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      WITH ranked AS (
        SELECT
          kind,
          id,
          environment,
          row_number() OVER (
            PARTITION BY environment, data ->> 'productId', data ->> 'leaseIp'
            ORDER BY
              COALESCE(NULLIF(data ->> 'updatedAt', '')::timestamptz, updated_at) DESC,
              id DESC
          ) AS rn
        FROM mx_platform_records
        WHERE kind = 'launcher-network-lease'
          AND data ->> 'status' = 'active'
          AND data ->> 'productId' IS NOT NULL
          AND data ->> 'leaseIp' IS NOT NULL
      )
      UPDATE mx_platform_records r
      SET
        data = jsonb_set(
          jsonb_set(
            jsonb_set(r.data, '{status}', '"released"', true),
            '{releasedAt}',
            to_jsonb(now()::text),
            true
          ),
          '{updatedAt}',
          to_jsonb(now()::text),
          true
        ),
        updated_at = now()
      FROM ranked
      WHERE r.kind = ranked.kind
        AND r.id = ranked.id
        AND r.environment = ranked.environment
        AND ranked.rn > 1
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_mx_launcher_active_lease_ip
      ON mx_platform_records (
        environment,
        ((data ->> 'productId')),
        ((data ->> 'leaseIp'))
      )
      WHERE kind = 'launcher-network-lease'
        AND data ->> 'status' = 'active'
        AND data ->> 'productId' IS NOT NULL
        AND data ->> 'leaseIp' IS NOT NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS uq_mx_launcher_active_lease_ip');
  }
}
