import { readSsoProfile } from '../server/identity/sso-config.mjs'
try { readSsoProfile(process.argv[2]); console.log('Hub SSO profile validated (credentials not printed)') }
catch { console.error('Hub SSO profile invalid; preserve the original file and verify its HTTPS addresses, key and permissions.'); process.exitCode = 1 }
