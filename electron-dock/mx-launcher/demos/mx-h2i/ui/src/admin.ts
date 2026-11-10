export type AdminPage = 'members';
export type AdminRequest = {
  action: 'workspace' | 'saveMember';
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
  firstSeenAt: string;
  lastSeenAt: string;
}
export interface AdminWorkspace {
  administratorId: string;
  members: AdminMember[];
}
export const adminPages: { id: AdminPage; label: string; title: string; icon: 'users' }[] = [
  { id: 'members', label: '成员', title: '成员与角色', icon: 'users' },
];
