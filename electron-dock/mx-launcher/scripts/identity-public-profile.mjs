import { generateKeyPairSync, randomBytes, randomUUID, createPrivateKey } from 'node:crypto';
import { isIP } from 'node:net';

export function publicOrigin(value) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.origin !== value || u.port || u.username || u.password || isIP(u.hostname)
    || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(u.hostname)) throw new Error('公网入口须为 HTTPS 域名，不带端口、路径或凭据');
  return u.origin;
}
export function validatePublicEntry(p, privateOrigin) {
  if (!p) return;
  const origin = publicOrigin(p.origin), admin = publicOrigin(p.adminOrigin);
  const transport = new URL(p.transportOrigin), internal = new URL(privateOrigin);
  if (origin === admin || p.issuer !== `${origin}/identity` || p.clientId !== 'mx-launcher-public-admin'
    || transport.protocol !== 'http:' || transport.hostname !== internal.hostname || transport.port !== '18444' || transport.origin !== p.transportOrigin
    || internal.port === transport.port || !/^[A-Za-z0-9_-]{43}$/.test(p.clientSecret) || !/^[A-Za-z0-9_-]{43}$/.test(p.ingressToken)
    || p.cookieKeys?.length !== 2 || p.cookieKeys.some(k => !/^[A-Za-z0-9_-]{43}$/.test(k)) || p.jwks?.keys?.length !== 1
    || p.applications?.length !== 1) throw new Error('公网身份档案无效；不能覆盖或重置已有凭据');
  createPrivateKey({key:p.jwks.keys[0],format:'jwk'});
  const app = p.applications[0];
  if (publicOrigin(app.origin) === origin || app.origin === admin || app.appId !== 'mx-insight-hub' || app.clientId !== 'mx-insight-hub-web'
    || !/^[A-Za-z0-9_-]{43}$/.test(app.clientSecret) || typeof app.audience !== 'string' || !app.audience) throw new Error('公网 Hub 客户端无效');
}
export function createPublicEntry({ origin, adminOrigin, hubOrigin, audience, privateOrigin }) {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength:3072 });
  const secret = () => randomBytes(32).toString('base64url');
  const p = { origin:publicOrigin(origin), adminOrigin:publicOrigin(adminOrigin), issuer:`${origin}/identity`,
    transportOrigin:`http://${new URL(privateOrigin).hostname}:18444`, clientId:'mx-launcher-public-admin', clientSecret:secret(), ingressToken:secret(),
    cookieKeys:[secret(),secret()], jwks:{keys:[{...privateKey.export({format:'jwk'}),kid:randomUUID(),use:'sig',alg:'RS256'}]},
    applications:[{clientId:'mx-insight-hub-web',clientSecret:secret(),origin:publicOrigin(hubOrigin),appId:'mx-insight-hub',audience}] };
  validatePublicEntry(p,privateOrigin); return p;
}
export function publicAdminConfig(p) {
  return { origin:p.adminOrigin, issuer:p.issuer, clientId:p.clientId, clientSecret:p.clientSecret,
    callbackUrl:`${p.adminOrigin}/auth/admin/callback`, localSubjects:true, ingressToken:p.ingressToken };
}
