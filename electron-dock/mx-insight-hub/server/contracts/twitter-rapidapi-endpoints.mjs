// Twitter AIO's reviewed read-only replies route, using the existing RapidAPI
// subscription. The raw TweetDetail response is retained (no format=simple).
// Contract: https://www.twittrapi.com/docs/reference/tweet-tweetid-replies
const key = 'r.twitter_aio_tweet_replies'
export const TWITTER_RAPIDAPI_COMMENT_ENDPOINT = Object.freeze({
  key, id: key, provider: 'rapidapi', host: 'twitter-aio.p.rapidapi.com',
  method: 'GET', path: '/tweet/{tweetId}/replies',
  summary: 'Twitter / X 帖子评论与评论回复', platform: 'twitter', platformLabel: 'Twitter / X',
  marketplace: 'twitter', authorizationPlatform: 'social',
  operation: `native.${key}`, endpointKey: `native.${key}`, hubPath: `/api/v1/data/native/${key}`,
  schemaVersion: 'twitter-aio.replies.2026-11-17', status: 'fixed_read_contract', reason: null,
  sourceUrl: 'https://www.twittrapi.com/docs/reference/tweet-tweetid-replies',
  parameters: Object.freeze([
    Object.freeze({ name: 'tweetId', in: 'path', type: 'string', required: true,
      pattern: '^[0-9]{1,30}$', description: '目标帖子或评论的数字 ID；评论本身也是一条帖子' }),
    Object.freeze({ name: 'cursor', type: 'string', required: false, minLength: 1, maxLength: 8192,
      description: '上一页的 Bottom 游标，原样传递；不自动补页' }),
    Object.freeze({ name: 'rankingMode', type: 'string', required: false,
      enum: ['Relevance', 'Recency', 'Likes'], default: 'Relevance', description: '评论排序' }),
    Object.freeze({ name: 'includePromotedContent', type: 'boolean', required: false,
      enum: [false], default: false, description: '当前只采集自然评论，不请求推广内容' }),
  ]),
  fixedQuery: Object.freeze({}),
})
