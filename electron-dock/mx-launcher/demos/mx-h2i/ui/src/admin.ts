export type AdminPage = 'overview' | 'applications' | 'members' | 'policies';
export type AdminRequest = {
  action: 'workspace' | 'saveMember' | 'saveApplication' | 'savePolicy';
  revision?: number;
  id?: string;
  value?: Record<string, unknown>;
};
export type AdminResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string } };
export interface AdminMember {
  id: string;
  name: string;
  department: string;
  role: 'admin' | 'employee' | null;
  enabled: boolean;
  accountActive: boolean;
  devices?: { name: string; platform: string | null }[];
  appIds?: string[];
  effectiveAppIds?: string[];
  firstSeenAt: string;
  lastSeenAt: string;
}
export interface AdminWorkspace {
  administratorId: string;
  members: AdminMember[];
  workspace?: WorkspaceSettings;
  memberPermissions?: boolean;
}
export const adminPages: {
  id: AdminPage;
  label: string;
  title: string;
  icon: import('./Icon').IconName;
}[] = [
  { id: 'overview', label: '总览', title: '管理总览', icon: 'grid' },
  { id: 'applications', label: '应用', title: '应用管理', icon: 'apps' },
  { id: 'members', label: '成员', title: '成员与设备', icon: 'users' },
  { id: 'policies', label: '策略', title: '访问策略', icon: 'shield' },
];

export interface ManagedApplication {
  id: string;
  name: string;
  url: string;
  category: string;
  published: boolean;
  icon: import('./Icon').IconName;
  color: string;
}
export interface ManagedPolicy {
  id: string;
  name: string;
  department: string;
  appIds: string[];
  action: 'allow' | 'deny';
  enabled: boolean;
}
export interface WorkspaceSettings {
  revision: number;
  applications: ManagedApplication[];
  policies: ManagedPolicy[];
}
export const appCategories = ['中台应用', '产品应用', '管理后台', '员工福利'];
