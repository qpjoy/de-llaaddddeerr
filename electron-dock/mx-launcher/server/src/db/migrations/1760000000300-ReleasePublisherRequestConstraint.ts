import type { MigrationInterface, QueryRunner } from 'typeorm';

export class ReleasePublisherRequestConstraint1760000000300 implements MigrationInterface {
  name = 'ReleasePublisherRequestConstraint1760000000300';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      DECLARE
        duplicate_count bigint;
      BEGIN
        SELECT count(*)
        INTO duplicate_count
        FROM (
          SELECT
            environment,
            data->>'productId' AS product_id,
            data->>'requestId' AS request_id
          FROM mx_platform_records
          WHERE kind = 'release-management-plan'
            AND NULLIF(data->>'publisherRequestFingerprint', '') IS NOT NULL
            AND NULLIF(data->>'productId', '') IS NOT NULL
            AND NULLIF(data->>'requestId', '') IS NOT NULL
          GROUP BY environment, data->>'productId', data->>'requestId'
          HAVING count(*) > 1
        ) duplicates;
        IF duplicate_count > 0 THEN
          RAISE EXCEPTION
            'Cannot enforce Release Publisher request uniqueness: % duplicate key(s) exist',
            duplicate_count;
        END IF;
      END
      $$;
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_mx_release_publisher_request
      ON mx_platform_records (
        environment,
        (data->>'productId'),
        (data->>'requestId')
      )
      WHERE kind = 'release-management-plan'
        AND NULLIF(data->>'publisherRequestFingerprint', '') IS NOT NULL
        AND NULLIF(data->>'productId', '') IS NOT NULL
        AND NULLIF(data->>'requestId', '') IS NOT NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS uq_mx_release_publisher_request');
  }
}
