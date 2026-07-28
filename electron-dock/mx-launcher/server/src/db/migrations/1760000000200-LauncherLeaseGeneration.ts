import type { MigrationInterface, QueryRunner } from 'typeorm';

export class LauncherLeaseGeneration1760000000200 implements MigrationInterface {
  name = 'LauncherLeaseGeneration1760000000200';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE SEQUENCE IF NOT EXISTS mx_launcher_lease_generation_seq START WITH 1'
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP SEQUENCE IF EXISTS mx_launcher_lease_generation_seq');
  }
}
