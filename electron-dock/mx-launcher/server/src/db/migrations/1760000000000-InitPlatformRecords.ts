import type { MigrationInterface, QueryRunner } from 'typeorm';

export class InitPlatformRecords1760000000000 implements MigrationInterface {
  name = 'InitPlatformRecords1760000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS mx_platform_records (
        kind varchar(80) NOT NULL,
        id varchar(160) NOT NULL,
        environment varchar(80) NOT NULL,
        site_id varchar(120),
        data jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT pk_mx_platform_records PRIMARY KEY (kind, id, environment)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_mx_platform_records_kind_environment
      ON mx_platform_records (kind, environment)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_mx_platform_records_site
      ON mx_platform_records (site_id)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_mx_platform_records_data
      ON mx_platform_records USING GIN (data)
    `);
    await queryRunner.query('CREATE SEQUENCE IF NOT EXISTS mx_overlay_ip_seq START WITH 20');
    await queryRunner.query('CREATE SEQUENCE IF NOT EXISTS mx_guest_ip_seq START WITH 20');
    await queryRunner.query('CREATE SEQUENCE IF NOT EXISTS mx_user_ip_seq START WITH 20');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP SEQUENCE IF EXISTS mx_user_ip_seq');
    await queryRunner.query('DROP SEQUENCE IF EXISTS mx_guest_ip_seq');
    await queryRunner.query('DROP SEQUENCE IF EXISTS mx_overlay_ip_seq');
    await queryRunner.query('DROP INDEX IF EXISTS idx_mx_platform_records_data');
    await queryRunner.query('DROP INDEX IF EXISTS idx_mx_platform_records_site');
    await queryRunner.query('DROP INDEX IF EXISTS idx_mx_platform_records_kind_environment');
    await queryRunner.query('DROP TABLE IF EXISTS mx_platform_records');
  }
}
