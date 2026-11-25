// Public request bodies used in the integration guide and deployment smoke tests.
export const marketplaceSearchExamples = {
  facebook: { capability: 'collect.ecommerce.fbmarketplace.search', input: { city: 'sanfrancisco', keyword: 'guitar', maxItems: 1 } },
  craigslist: { capability: 'collect.classifieds.craigslist.search', input: { region: 'newyork', keyword: 'bicycle', maxItems: 1 } },
  shopify: { capability: 'collect.ecommerce.shopify.search', input: { domain: 'www.deathwishcoffee.com', keyword: 'coffee', maxItems: 1 } },
}
