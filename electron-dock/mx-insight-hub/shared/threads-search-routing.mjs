// A strategy choice for a second listing on RapidAPI. Both listings use the
// same RapidAPI credentials, but a subscription covers only its own listing.
export const THREADS_SCRAPER_ROUTE = 'rapidapi-threads-scraper'

const withTikHub = Object.freeze(['rapidapi', THREADS_SCRAPER_ROUTE, 'tikhub'])
export const THREADS_BUSINESS_ROUTES = Object.freeze({
  search: withTikHub, crawl: withTikHub, 'user-info': withTikHub,
  'post-detail': Object.freeze(['rapidapi', THREADS_SCRAPER_ROUTE]),
})
