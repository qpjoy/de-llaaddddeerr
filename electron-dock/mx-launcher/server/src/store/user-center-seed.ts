import type {
  ImportUserCenterUserRow,
  ImportUserCenterUsersInput,
  UserCenterUser
} from '../types.js';

export const LEGACY_HDO_HOME_APP_ID = 'mx-h2i';
export const LEGACY_HDO_ALLOWED_APP_IDS = ['mx-h2i', 'appcenter', 'h2o'];
export const LEGACY_HDO_SEED_REQUEST_ID = 'legacy-hdo-user-seed-v1';

export const legacyHdoAdminSeed = {
  id: 1,
  account: 'admin',
  password: 'adminsj8kx1sq6xc',
  user_name: 'admin'
} as const;

export const legacyHdoUserCenterSeedRows: ImportUserCenterUserRow[] = [
  { id: 2, account: 'bmyq', password: 'bmyqe7ce94382f7c', user_name: 'bmyq' },
  { id: 3, account: 'bmjx', password: 'bmjxEg1cl9CXOVD5', user_name: 'bmjx' },
  { id: 4, account: 'yqcs', password: 'yqcsds8agn5tl9dn', user_name: 'yqcs' },
  { id: 7, account: 'yqjx', password: 'yqjxdjocqjf58ad2', user_name: 'yqjx' },
  { id: 8, account: 'whyq', password: 'whyqa99a84457c5d', user_name: 'whyq' },
  { id: 11, account: 'qdcs', password: 'qdcs2o5qsdqwf5kn', user_name: 'qdcs' },
  { id: 6, account: 'nmtest', password: 'nmtestsadhadqiow', user_name: 'nmtest' },
  { id: 12, account: 'public', password: 'publics3ohd1akd9', user_name: 'public' },
  { id: 13, account: 'anonymous', password: 'anonymous15e83su', user_name: 'anonymous' },
  { id: 15, account: 'bmcq', password: 'bmcq15sdqwjsa6e1', user_name: 'bmcq' },
  { id: 16, account: 'bmlyg', password: 'bmlygsjw973qwe15', user_name: 'bmlyg' },
  { id: 14, account: 'bmzs', password: 'bmzs23v5kazlsad1', user_name: 'bmzs' },
  { id: 17, account: 'szsj', password: 'szsj5awr7mzph85a', user_name: 'szsj' },
  { id: 9, account: 'test', password: 'test', user_name: 'test' },
  { id: 18, account: 'demo-test', password: 'demotest2scl2bsk', user_name: 'demo-test' },
  { id: 19, account: 'ycwa', password: 'ycwaxjrt5dskoq09', user_name: 'ycwa' }
];

export function legacyHdoUserCenterSeedInput(users = legacyHdoUserCenterSeedRows): ImportUserCenterUsersInput {
  return {
    users,
    defaultRoleIds: ['mx-user'],
    defaultOrgIds: ['org_default'],
    defaultHomeAppId: LEGACY_HDO_HOME_APP_ID,
    defaultRegisteredByAppId: LEGACY_HDO_HOME_APP_ID,
    defaultAllowedAppIds: LEGACY_HDO_ALLOWED_APP_IDS,
    requestedBy: 'legacy-hdo-user-seed',
    requestId: LEGACY_HDO_SEED_REQUEST_ID
  };
}

export function mergeUniqueUserCenterUsers(users: UserCenterUser[]): UserCenterUser[] {
  return [...users.reduce<Map<string, UserCenterUser>>((items, user) => {
    items.set(user.userId, user);
    return items;
  }, new Map()).values()];
}

export function legacyHdoSeedUserIsComplete(user: UserCenterUser | null, hasPasswordCredential: boolean): boolean {
  if (!user || !hasPasswordCredential) return false;
  const allowed = new Set(user.appAccess.allowedAppIds);
  return (
    user.appAccess.homeAppId === LEGACY_HDO_HOME_APP_ID
    && user.appAccess.registeredByAppId === LEGACY_HDO_HOME_APP_ID
    && LEGACY_HDO_ALLOWED_APP_IDS.every((appId) => allowed.has(appId))
  );
}
