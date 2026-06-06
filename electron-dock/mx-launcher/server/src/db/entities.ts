import { EntitySchema } from 'typeorm';

export interface PlatformRecordRow {
  kind: string;
  id: string;
  environment: string;
  siteId: string | null;
  data: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export const PlatformRecordEntity = new EntitySchema<PlatformRecordRow>({
  name: 'PlatformRecord',
  tableName: 'mx_platform_records',
  columns: {
    kind: {
      type: String,
      length: 80,
      primary: true
    },
    id: {
      type: String,
      length: 160,
      primary: true
    },
    environment: {
      type: String,
      length: 80,
      primary: true
    },
    siteId: {
      name: 'site_id',
      type: String,
      length: 120,
      nullable: true
    },
    data: {
      type: 'jsonb'
    },
    createdAt: {
      name: 'created_at',
      type: 'timestamptz',
      createDate: true
    },
    updatedAt: {
      name: 'updated_at',
      type: 'timestamptz',
      updateDate: true
    }
  },
  indices: [
    {
      name: 'idx_mx_platform_records_kind_environment',
      columns: ['kind', 'environment']
    },
    {
      name: 'idx_mx_platform_records_site',
      columns: ['siteId']
    }
  ]
});
