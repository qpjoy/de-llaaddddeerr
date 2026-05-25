import type { FastifyInstance } from 'fastify';

import { storage } from '../../data/storage.js';
import { entitlementsStore } from '../../data/index.js';
import { attachUser } from '../../auth/middleware.js';
import type { MarketplaceEntryDTO } from '../../data/types.js';
import { isUserInstallableMarketplaceEntry } from '../../marketplaceFilters.js';

export async function marketplaceRoutes(app: FastifyInstance): Promise<void> {
  // Parse optional Bearer to filter by visibility.
  app.addHook('preHandler', attachUser);

  app.get('/api/v1/marketplace/index.json', async (req, reply) => {
    const idx = storage.getIndex();
    if (!idx) {
      reply.code(200).type('application/json');
      return {
        generatedAt: new Date(0).toISOString(),
        release: 'bootstrap',
        entries: []
      };
    }

    const user = req.currentUser;
    const ownedPluginIds = user
      ? new Set((await entitlementsStore.forUser(user.id)).map((e) => e.pluginId))
      : new Set<string>();

    // Visibility filter:
    //   public           — everyone
    //   free             — any authed user
    //   paid             — authed user with entitlement OR admin
    //   private          — admin only (creator + share-link later)
    const filtered = idx.entries.filter((e) => entryVisible(e, user, ownedPluginIds));

    const etag = storage.indexEtag() ?? undefined;
    // Etag here covers the un-filtered set. If a user gains/loses an
    // entitlement we still serve a fresh response because the filter
    // changes — set the etag based on the user-specific view instead.
    const personalisedEtag = user ? `${etag ?? ''}.u-${user.id}` : etag;
    if (personalisedEtag && req.headers['if-none-match'] === personalisedEtag) {
      reply.code(304).send();
      return;
    }

    reply
      .code(200)
      .header('etag', personalisedEtag ?? '')
      .header('cache-control', user ? 'private, max-age=10' : 'public, max-age=60')
      .type('application/json');

    return {
      generatedAt: idx.generatedAt,
      release: idx.release,
      entries: filtered
    };
  });
}

function entryVisible(
  entry: MarketplaceEntryDTO,
  user: { role: 'user' | 'admin' | 'banned' } | null,
  owned: Set<string>
): boolean {
  if (!isUserInstallableMarketplaceEntry(entry)) return false;
  switch (entry.visibility) {
    case 'public':
      return true;
    case 'free':
      return Boolean(user);
    case 'paid':
      if (!user) return false;
      if (user.role === 'admin') return true;
      return owned.has(entry.id);
    case 'private':
      return user?.role === 'admin';
    default:
      return true; // unknown values default to visible — safer than hiding
  }
}
