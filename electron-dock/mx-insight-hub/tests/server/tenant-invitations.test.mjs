import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import pg from 'pg'
import { TenantInvitations } from '../../server/identity/tenant-invitations.mjs'
import { SsoStore } from '../../server/identity/sso-store.mjs'
import { adminTokenPrincipal, capabilitiesForRole } from '../../server/identity/index.mjs'

const connectionString=process.env.MX_SSO_TEST_DATABASE_URL
test('tenant invitations: real PostgreSQL permissions, atomic creation/acceptance, concurrency, revocation and identity preservation',{skip:!connectionString},async t=>{
  const target=new URL(connectionString)
  assert.ok(['127.0.0.1','localhost'].includes(target.hostname) && target.pathname.includes('sso_test'))
  const adminPool=new pg.Pool({connectionString}), dbName=`hub_invite_${randomUUID().replaceAll('-','')}`
  await adminPool.query(`CREATE DATABASE ${dbName}`);target.pathname=`/${dbName}`
  const pool=new pg.Pool({connectionString:target.href})
  t.after(async()=>{await pool.end();await adminPool.query(`DROP DATABASE ${dbName} WITH (FORCE)`);await adminPool.end()})
  const migration=name=>readFileSync(new URL(`../../migrations/${name}`,import.meta.url),'utf8')
  const files=readdirSync(new URL('../../migrations/',import.meta.url))
  for(const prefix of ['001_','007_','124_','125_'])await pool.query(migration(files.find(name=>name.startsWith(prefix))))
  await pool.query(migration('123_payment_delivery.sql').split('CREATE SCHEMA hub_recharge;')[0])
  await pool.query(migration('125_tenant_invitations.sql'))
  const settings={pool,sessions:new SsoStore(pool,randomBytes(32).toString('base64url')),origin:'https://hub.test',adminToken:'fixture-admin-token'}
  let invites=new TenantInvitations(settings)
  const admin=adminTokenPrincipal()
  const tenant=async name=>{const id=randomUUID();await pool.query("INSERT INTO tenants(id,name,status) VALUES($1,$2,'active')",[id,name]);return id}
  const member=async name=>{const id=randomUUID();await pool.query('INSERT INTO iam.members(id,display_name) VALUES($1,$2)',[id,name]);return id}
  const company=await tenant('Original company'), otherCompany=await tenant('Other company')
  const ownerId=await member('Owner'), viewerId=await member('Existing viewer'), newcomer=await member('New colleague'), another=await member('Other colleague')
  const grant=async(id,tenantId,role,status='active')=>pool.query(`INSERT INTO iam.tenant_memberships(id,member_id,tenant_id,role,status) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(member_id,tenant_id) DO UPDATE SET role=EXCLUDED.role,status=EXCLUDED.status`,[randomUUID(),id,tenantId,role,status])
  await grant(ownerId,company,'owner');await grant(viewerId,company,'viewer')
  const principal=(id,role='viewer')=>({kind:'launcher-user',memberId:id,platformAdmin:false,tenantIds:[company],memberships:[{tenantId:company,role,capabilities:capabilitiesForRole(role)}]})
  const owner=principal(ownerId,'owner'), viewer=principal(viewerId)
  const input=(patch={})=>({requestId:randomUUID(),tenantId:company,label:'Colleague',role:'viewer',days:7,allowRegistration:true,...patch})
  const secret=invitation=>new URLSearchParams(new URL(invitation.url).hash.split('?')[1]).get('invitation')
  const membership=async(id,tenantId=company)=>(await pool.query('SELECT * FROM iam.tenant_memberships WHERE member_id=$1 AND tenant_id=$2',[id,tenantId])).rows[0]
  const fails=(operation,code)=>assert.rejects(operation,error=>error.code===code)
  await t.test('only own-tenant owners/platform admins may invite, no secrets in lists',async()=>{
    await fails(invites.create(viewer,input()),'insufficient_capability')
    await fails(invites.create(principal(ownerId,'admin'),input()),'insufficient_capability')
    await fails(invites.create(owner,input({tenantId:otherCompany})),'tenant_not_permitted')
    await fails(invites.create(owner,input({tenantId:null,tenantName:'Unauthorized company'})),'platform_admin_required')
    const invitation=await invites.create(owner,input())
    const raw=secret(invitation), listed=await invites.list(owner,company)
    assert.ok(!JSON.stringify(listed).includes(raw));assert.equal(listed[0].tokenHash,undefined)
    const stored=(await pool.query('SELECT * FROM iam.tenant_invitations WHERE id=$1',[invitation.id])).rows[0]
    assert.ok(!JSON.stringify(stored).includes(raw));assert.equal(stored.creator_id,ownerId)
    await fails(invites.list(viewer,company),'insufficient_capability')
  })
  await t.test('create tenant and first-owner invitation atomically, same request replays same link',async()=>{
    const body=input({tenantId:null,tenantName:'Invited company',role:'owner'})
    const [a,b]=await Promise.all([invites.create(admin,body),invites.create(admin,body)])
    assert.equal(a.url,b.url);assert.equal(a.tenantId,b.tenantId)
    assert.equal((await pool.query("SELECT count(*)::int n FROM tenants WHERE name='Invited company'")).rows[0].n,1)
    assert.equal((await pool.query('SELECT count(*)::int n FROM iam.tenant_memberships WHERE tenant_id=$1',[a.tenantId])).rows[0].n,0)
    await fails(invites.create(admin,{...body,label:'Changed'}),'invitation_request_changed')
    const joined=await invites.accept(principal(newcomer),secret(a));assert.equal(joined.role,'owner')
    assert.equal((await membership(newcomer,a.tenantId)).role,'owner')
    await pool.query("UPDATE tenants SET status='suspended' WHERE id=$1",[a.tenantId])
    await fails(invites.accept(principal(newcomer),secret(a)),'invitation_unavailable')
    await pool.query("UPDATE tenants SET status='active' WHERE id=$1",[a.tenantId])
    const failing=new TenantInvitations(settings)
    failing.audit=async()=>{throw new Error('injected creation audit failure')}
    await assert.rejects(failing.create(admin,input({tenantId:null,tenantName:'Rolled back company',role:'owner'})),/injected creation audit failure/)
    assert.equal((await pool.query("SELECT count(*)::int n FROM tenants WHERE name='Rolled back company'")).rows[0].n,0)
  })
  await t.test('two accounts racing for one link yield exactly one acceptance; retry cannot duplicate',async()=>{
    const invitation=await invites.create(owner,input({role:'analyst'})), token=secret(invitation)
    const ids=[newcomer,another]
    const results=await Promise.allSettled(ids.map(id=>invites.accept(principal(id),token)))
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
    const winner=ids[results.findIndex(r=>r.status==='fulfilled')]
    const first=await membership(winner)
    assert.equal((await invites.accept(principal(winner),token)).role,'analyst')
    assert.equal((await membership(winner)).id,first.id)
    assert.equal((await invites.inspect(token,winner)).status,'accepted')
    await grant(winner,company,'analyst','suspended')
    await fails(invites.accept(principal(winner),token),'membership_suspended')
    assert.equal((await membership(winner)).status,'suspended')
  })
  await t.test('existing roles are preserved; suspended members cannot return via a fresh invitation',async()=>{
    const before=await membership(viewerId), invitation=await invites.create(owner,input({role:'owner'}))
    assert.equal((await invites.accept(viewer,secret(invitation))).role,'viewer')
    assert.deepEqual(await membership(viewerId),before)
    await grant(viewerId,company,'viewer','suspended')
    const other=await invites.create(owner,input())
    await fails(invites.accept(viewer,secret(other)),'membership_suspended')
    await grant(viewerId,company,'viewer')
  })
  await t.test('expiry, tenant disable, inviter demotion, revoke and token rotation are rechecked',async()=>{
    const a=await invites.create(owner,input());await pool.query("UPDATE iam.tenant_invitations SET expires_at=now()-interval '1 second' WHERE id=$1",[a.id])
    await fails(invites.inspect(secret(a)),'invitation_unavailable')
    const b=await invites.create(owner,input());await grant(ownerId,company,'admin')
    await fails(invites.registrationProof(b.id),'invitation_unavailable')
    await grant(ownerId,company,'owner')
    await pool.query("UPDATE tenants SET status='suspended' WHERE id=$1",[company]);await fails(invites.inspect(secret(b)),'invitation_unavailable')
    await pool.query("UPDATE tenants SET status='active' WHERE id=$1",[company])
    await invites.revoke(owner,b.id);await invites.revoke(owner,b.id);await fails(invites.inspect(secret(b)),'invitation_unavailable')
    const c=await invites.create(admin,input());const rotated=new TenantInvitations({...settings,adminToken:'rotated-token'})
    await fails(rotated.inspect(secret(c)),'invitation_unavailable')
    const d=await invites.create(owner,input({allowRegistration:false}));await fails(invites.registrationProof(d.id),'invitation_registration_disabled')
  })
  await t.test('audit failure rolls back both membership and consumption; restart retains outcomes',async()=>{
    const id=await member('Fault recovery'), invitation=await invites.create(owner,input({role:'billing'})), token=secret(invitation)
    await pool.query(`CREATE FUNCTION invitation_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.event_type='invitation.accepted' THEN RAISE EXCEPTION 'injected audit failure'; END IF; RETURN NEW; END $$`)
    await pool.query('CREATE TRIGGER invitation_audit_fault BEFORE INSERT ON iam.identity_events FOR EACH ROW EXECUTE FUNCTION invitation_audit_fault()')
    try {await assert.rejects(invites.accept(principal(id),token),/injected audit failure/)}
    finally {await pool.query('DROP TRIGGER invitation_audit_fault ON iam.identity_events');await pool.query('DROP FUNCTION invitation_audit_fault()')}
    assert.equal(await membership(id),undefined);assert.equal((await invites.inspect(token)).status,'pending')
    assert.equal((await invites.accept(principal(id),token)).role,'billing')
    invites=new TenantInvitations(settings)
    assert.equal((await invites.accept(principal(id),token)).role,'billing')
    assert.equal((await pool.query("SELECT count(*)::int n FROM iam.identity_events WHERE event_type='invitation.accepted' AND detail->>'invitationId'=$1",[invitation.id])).rows[0].n,1)
    await fails(invites.revoke(owner,invitation.id),'invitation_accepted')
    assert.equal((await pool.query('SELECT count(*)::int n FROM consumers')).rows[0].n,0)
    assert.equal((await pool.query('SELECT count(*)::int n FROM api_keys')).rows[0].n,0)
  })
})
