import type { MigrationInterface, QueryRunner } from 'typeorm';

export class LauncherProductServiceVipConstraint1760000000400 implements MigrationInterface {
  name = 'LauncherProductServiceVipConstraint1760000000400';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      DECLARE
        invalid_count bigint;
        duplicate_count bigint;
      BEGIN
        SELECT count(*)
        INTO invalid_count
        FROM mx_platform_records
        WHERE kind = 'launcher-product-network'
          AND data->>'enabled' IS DISTINCT FROM 'false'
          AND CASE
            WHEN BTRIM(data->>'serviceVip') ~ '^[0-9]{1,3}([.][0-9]{1,3}){3}$'
              THEN NOT (
                split_part(BTRIM(data->>'serviceVip'), '.', 1)::integer BETWEEN 0 AND 255
                AND split_part(BTRIM(data->>'serviceVip'), '.', 2)::integer BETWEEN 0 AND 255
                AND split_part(BTRIM(data->>'serviceVip'), '.', 3)::integer BETWEEN 0 AND 255
                AND split_part(BTRIM(data->>'serviceVip'), '.', 4)::integer BETWEEN 0 AND 255
              )
            ELSE true
          END;
        IF invalid_count > 0 THEN
          RAISE EXCEPTION
            'Cannot enforce Launcher ProductNetwork service VIP uniqueness: % enabled record(s) contain a missing or invalid IPv4 serviceVip; repair them before retrying',
            invalid_count;
        END IF;

        SELECT count(*)
        INTO duplicate_count
        FROM (
          -- Compare octets numerically. Older builds accepted and persisted
          -- leading-zero spellings such as 010.088.100.001; those own the same
          -- host route as 10.88.100.1 and must therefore collide.
          SELECT
            split_part(BTRIM(data->>'serviceVip'), '.', 1)::integer AS octet_1,
            split_part(BTRIM(data->>'serviceVip'), '.', 2)::integer AS octet_2,
            split_part(BTRIM(data->>'serviceVip'), '.', 3)::integer AS octet_3,
            split_part(BTRIM(data->>'serviceVip'), '.', 4)::integer AS octet_4
          FROM mx_platform_records
          WHERE kind = 'launcher-product-network'
            AND data->>'enabled' IS DISTINCT FROM 'false'
          GROUP BY octet_1, octet_2, octet_3, octet_4
          HAVING count(*) > 1
        ) duplicates;
        IF duplicate_count > 0 THEN
          RAISE EXCEPTION
            'Cannot enforce Launcher ProductNetwork service VIP uniqueness: % duplicate enabled service VIP(s) exist; resolve the conflicting records before retrying',
            duplicate_count;
        END IF;
      END
      $$;
    `);
    await queryRunner.query(`
      ALTER TABLE mx_platform_records
      ADD CONSTRAINT ck_mx_launcher_enabled_product_service_vip_ipv4
      CHECK (
        CASE
          WHEN kind = 'launcher-product-network'
            AND data->>'enabled' IS DISTINCT FROM 'false'
            THEN CASE
              WHEN BTRIM(data->>'serviceVip') ~ '^[0-9]{1,3}([.][0-9]{1,3}){3}$'
                THEN
                  split_part(BTRIM(data->>'serviceVip'), '.', 1)::integer BETWEEN 0 AND 255
                  AND split_part(BTRIM(data->>'serviceVip'), '.', 2)::integer BETWEEN 0 AND 255
                  AND split_part(BTRIM(data->>'serviceVip'), '.', 3)::integer BETWEEN 0 AND 255
                  AND split_part(BTRIM(data->>'serviceVip'), '.', 4)::integer BETWEEN 0 AND 255
              ELSE false
            END
          ELSE true
        END
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_mx_launcher_enabled_product_service_vip
      ON mx_platform_records (
        ((split_part(BTRIM(data->>'serviceVip'), '.', 1))::integer),
        ((split_part(BTRIM(data->>'serviceVip'), '.', 2))::integer),
        ((split_part(BTRIM(data->>'serviceVip'), '.', 3))::integer),
        ((split_part(BTRIM(data->>'serviceVip'), '.', 4))::integer)
      )
      WHERE kind = 'launcher-product-network'
        AND data->>'enabled' IS DISTINCT FROM 'false'
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS uq_mx_launcher_enabled_product_service_vip');
    await queryRunner.query(
      'ALTER TABLE mx_platform_records DROP CONSTRAINT IF EXISTS ck_mx_launcher_enabled_product_service_vip_ipv4'
    );
  }
}
