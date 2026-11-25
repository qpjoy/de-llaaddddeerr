import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {permittedCustomerRoute} from '../apps/server/app.mjs';
const tenant=randomUUID(),member=randomUUID(),ticket=randomUUID();
test('customer allowlist exposes only scoped enterprise workflows, never platform support processing',()=>{
 for(const path of [`/enterprises/${tenant}/profile`,`/enterprises/${tenant}/members/${member}/reset-password`,`/commerce/tenants/${tenant}/messages/read-all`])assert.equal(permittedCustomerRoute('POST',path),true,path);
 assert.equal(permittedCustomerRoute('GET',`/enterprises/${tenant}/tickets/${ticket}`),true);
 for(const path of [`/enterprises/${tenant}/challenge`,'/dataport/tickets','/admin/dataport/tickets',`/enterprises/${tenant}/tickets/${ticket}`,`/enterprises/${tenant}/members/${member}/reveal`])assert.equal(permittedCustomerRoute('POST',path),false,path);
 assert.equal(permittedCustomerRoute('GET',`/enterprises/${tenant}/members/${member}/reset-password`),false);
});
