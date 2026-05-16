#!/usr/bin/env tsx
/**
 * Create the first admin user.
 *
 *   pnpm admin:bootstrap -- --username qpjoy --password 'something-long'
 *
 * Works with both JSON and Postgres backends — it goes through the storage
 * proxy. Set DATABASE_URL to target Postgres.
 */
import { initStorage, usersStore } from '../src/data/index.js';
import { register } from '../src/auth/service.js';
import { toPublic } from '../src/auth/types.js';

interface Args {
  username?: string;
  email?: string;
  phone?: string;
  password?: string;
  displayName?: string;
}

function parse(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) continue;
    (out as Record<string, string>)[k.slice(2)] = next;
    i++;
  }
  return out;
}

async function main(): Promise<void> {
  await initStorage();

  const args = parse(process.argv.slice(2));
  if (!args.password || (!args.username && !args.email && !args.phone)) {
    // eslint-disable-next-line no-console
    console.error(
      'usage: pnpm admin:bootstrap -- --username <u> [--email <e>] [--phone <p>] --password <pw>'
    );
    process.exit(2);
  }

  const { user, tokens } = await register({
    username: args.username,
    email: args.email,
    phone: args.phone,
    password: args.password,
    displayName: args.displayName ?? args.username ?? args.email ?? args.phone
  });

  if (user.role !== 'admin') {
    const row = await usersStore.update(user.id, { role: 'admin' });
    if (row) Object.assign(user, toPublic(row));
  }

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ user, tokens }, null, 2));
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
