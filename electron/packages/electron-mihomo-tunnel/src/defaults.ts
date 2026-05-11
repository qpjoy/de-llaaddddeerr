import { randomBytes } from 'crypto';

import type { RuntimeMode, TunnelPorts } from './types';

export const DEFAULT_PORTS: TunnelPorts = {
  admin: 23456,
  controller: 23457,
  mixed: 7890,
  dns: 1053
};

export const DEFAULT_MODE: RuntimeMode = 'app-rule';

export const DEFAULT_ADMIN_USER = 'admin';

export const DEFAULT_ADMIN_PASSWORD = 'admin';

export function createControllerSecret(): string {
  return randomBytes(24).toString('hex');
}

export const GEOX_URL = {
  geoip: 'https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geoip.dat',
  geosite: 'https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geosite.dat',
  mmdb: 'https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/country.mmdb'
};

export const DOMAIN_PRESETS = {
  google: [
    'google.com',
    'googleapis.com',
    'gstatic.com',
    'googleusercontent.com',
    'googlevideo.com',
    'ggpht.com',
    'gmail.com',
    'googlemail.com',
    'google-analytics.com',
    'googletagmanager.com',
    'googlesyndication.com',
    'doubleclick.net',
    'blogger.com',
    'chrome.com',
    'chromium.org'
  ],
  youtube: [
    'youtube.com',
    'youtu.be',
    'ytimg.com',
    'youtubei.googleapis.com',
    'youtube-nocookie.com',
    'googlevideo.com',
    'yt3.ggpht.com'
  ],
  x: [
    'x.com',
    'twitter.com',
    't.co',
    'twimg.com',
    'tweetdeck.com',
    'ads-twitter.com',
    'pscp.tv',
    'periscope.tv'
  ],
  telegram: [
    'telegram.org',
    'telegram.me',
    't.me',
    'tdesktop.com',
    'telegra.ph',
    'tdlib.org'
  ]
} as const;

export type DomainPresetId = keyof typeof DOMAIN_PRESETS;
