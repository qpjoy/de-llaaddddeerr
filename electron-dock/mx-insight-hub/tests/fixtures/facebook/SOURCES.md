# Facebook field-calibration fixture sources

Checked on 2026-10-15 (Asia/Shanghai). These fixtures are synthetic test data,
not retained customer responses or evidence that a live acquisition succeeded.
The audit read public documentation, static SDK files and the documentation's
already stored response example. It sent no authenticated or paid collection
requests and used no provider credentials.

## JustOne search

- Documentation: <https://docs.justoneapi.com/zh/api/facebook/post-search-v1>
- Public OpenAPI: <https://docs.justoneapi.com/openapi/facebook/post-search-v1-zh.json>
- Existing example resource used by the official documentation:
  <https://api.justoneapi.com/status/api-example/detail?api=%2Fapi%2Ffacebook%2Fsearch-post%2Fv1>
  The returned metadata had `synthetic: false` and
  `checkedAt: "2026-10-14T20:00:08"`. No timezone was supplied for that field.
- Official SDK request implementation:
  <https://github.com/justoneapi-official/justoneapi-python/blob/main/justoneapi/generated/resources/facebook.py>
- Older public response sample in the official SDK repository:
  <https://github.com/justoneapi-official/justoneapi-python/blob/main/docs/api-examples/getApiFacebookSearchPostV1.json>
  Its stored source-check timestamp was `2026-09-08T20:00:08`.

`justone-search.success.json` retains reviewed structural differences from the
official examples: `code: 0`, `data.results`, sibling `data.cursor`, `post_id`,
`message`/`message_rich`, numeric epoch-second `timestamp`, nested `author`,
`reactions_count`/`comments_count`/`reshare_count`, and null video/view fields.
Both inspected official search examples contained six posts. The current example
included an album, a single image and text-only posts. Album elements supplied
`type: "photo"`, a CDN image in `image_file_uri`, and a distinct Facebook
`photo.php` landing page in `url`; the single-image shape used `image.uri` with
width, height and ID. `images_count` can exceed the returned album-preview
length, so it must not be treated as a count of delivered image assets.

All fixture IDs, author data, text, timestamps, counters, URLs and cursors are
invented. Media URLs use the reserved `.test` namespace. The Facebook URLs only
exercise landing-page classification and must not be fetched. The fixture cursor
is a replacement opaque string: the actual example supplied a serialized JSON
string containing further escaped cursor state, which Hub must carry unchanged.
Neither inspected official search example contained a non-null video,
`video_files` or `video_thumbnail`. Consequently this fixture does not claim an
observed current JustOne search video schema. Existing local historical video
fixtures remain compatibility evidence only.

The official SDK exposes `keyword`, `start_date`, `end_date` and `cursor`, then
sends `keyword`, `startDate`, `endDate` and `cursor`. The dates are inclusive
calendar days. The official contract documents basic text search, without
specifying Boolean expression semantics or accepting a result-count parameter.
Its successful response `data` is typed as unconstrained data; the response
example, rather than an invented OpenAPI item schema, grounds this fixture.

## RapidAPI search

`rapid-search.success.json` is synthetic compatibility data based on the
existing reviewed Hub adapter and Night-All's Facebook RapidAPI crawler and
tests (`crawlers/facebook/rapid/SearchPosts.py` and
`tests/test_facebook_rapid_search_posts.py`). It is not a downloaded official
successful response or a paid live response. It exercises the historical
`results`/`cursor` envelope, image references, video-file dictionaries, video
poster separation, explicit zero counters and absent counters. The accompanying
unit tests may deliberately modify types and aliases to check deterministic Hub
normalization; those variants are not claims about a supplier's current schema.
