export const CONSENT_STORAGE_KEY = "dataport_cookie_consent";
export const CONSENT_VERSION = "2026-10-08";
export const CONSENT_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;
export const PREFERENCE_COOKIE = "sidebar_state";
export const PREFERENCE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

export type CookieConsent = {
  version: typeof CONSENT_VERSION;
  necessary: true;
  preferences: boolean;
  savedAt: number;
  expiresAt: number;
};

export function createCookieConsent(
  preferences: boolean,
  now = Date.now(),
): CookieConsent {
  return {
    version: CONSENT_VERSION,
    necessary: true,
    preferences,
    savedAt: now,
    expiresAt: now + CONSENT_MAX_AGE_MS,
  };
}

export function parseCookieConsent(
  raw: string | null,
  now = Date.now(),
): CookieConsent | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    if (
      !value ||
      value.version !== CONSENT_VERSION ||
      value.necessary !== true ||
      typeof value.preferences !== "boolean" ||
      !Number.isSafeInteger(value.savedAt) ||
      !Number.isSafeInteger(value.expiresAt) ||
      value.savedAt > now ||
      value.savedAt < 0 ||
      value.expiresAt <= now ||
      value.expiresAt !== value.savedAt + CONSENT_MAX_AGE_MS
    )
      return null;
    return createCookieConsent(value.preferences, value.savedAt);
  } catch {
    return null;
  }
}

export function readCookieConsent(): CookieConsent | null {
  if (typeof window === "undefined") return null;
  try {
    return parseCookieConsent(window.localStorage.getItem(CONSENT_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function clearPreferenceCookies() {
  document.cookie = `${PREFERENCE_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
}

export function saveCookieConsent(consent: CookieConsent): boolean {
  if (!consent.preferences) clearPreferenceCookies();
  try {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(consent));
    return true;
  } catch {
    clearPreferenceCookies();
    return false;
  }
}

export function readSidebarPreference(): boolean | null {
  if (!readCookieConsent()?.preferences) return null;
  const value = document.cookie
    .split("; ")
    .find((item) => item.startsWith(`${PREFERENCE_COOKIE}=`))
    ?.split("=")[1];
  return value === "true" ? true : value === "false" ? false : null;
}

export function saveSidebarPreference(open: boolean) {
  const consent = readCookieConsent();
  if (!consent?.preferences) {
    clearPreferenceCookies();
    return;
  }
  const maxAge = Math.min(
    PREFERENCE_MAX_AGE_SECONDS,
    Math.floor((consent.expiresAt - Date.now()) / 1000),
  );
  document.cookie = `${PREFERENCE_COOKIE}=${open}; Path=/; Max-Age=${maxAge}; SameSite=Lax${window.location.protocol === "https:" ? "; Secure" : ""}`;
}
