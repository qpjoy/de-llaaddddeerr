// Field projection retained from Night-All's TikHub normalizer (2026-10-15).
// Hub chooses exact collection containers and verifies identities separately;
// never use Night-All's recursive array guessing or synthetic identity fallback.
function videoPlaybackUrl(item) {
  if (typeof item === 'string') return firstString(item);
  if (!item || typeof item !== 'object') return '';
  return firstString(item.playUrl, item.play_url, item.url);
}

function preferredVideoVariants(videos, platform) {
  const values = Array.isArray(videos) ? videos.filter(videoPlaybackUrl) : [];
  if (!/^(?:xiaohongshu|xhs|redbook)$/i.test(String(platform || '').trim()) || values.length < 2) {
    return values;
  }
  function codecRank(item) {
    if (!item || typeof item !== 'object') return 2;
    const codec = firstString(item.codec, item.video_codec, item.codec_type, item.stream_key, item.streamKey, item.quality).toLowerCase();
    if (/h\.?264|avc/.test(codec)) return 4;
    if (/h\.?265|hevc/.test(codec)) return 1;
    if (/av1/.test(codec)) return 0;
    return 2;
  }
  function numberValue(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }
  const ranked = values.map((item, index) => ({
    item,
    index,
    codec: codecRank(item),
    area: item && typeof item === 'object'
      ? numberValue(item.width || item.w) * numberValue(item.height || item.h)
      : 0,
    bitrate: item && typeof item === 'object'
      ? numberValue(item.bitrate || item.video_bitrate)
      : 0
  }));
  ranked.sort((left, right) =>
    right.codec - left.codec ||
    right.area - left.area ||
    right.bitrate - left.bitrate ||
    left.index - right.index
  );
  return [ranked[0].item];
}

function firstString() {
  for (let i = 0; i < arguments.length; i += 1) {
    const value = arguments[i];
    if (typeof value === 'string' && value.trim()) return value;
    if (typeof value === 'number') return String(value);
  }
  return '';
}

function firstNumber() {
  for (let i = 0; i < arguments.length; i += 1) {
    const value = arguments[i];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function firstMetric() {
  for (let i = 0; i < arguments.length; i += 1) {
    const value = arguments[i];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = firstMetric(value.count, value.value, value.total);
      if (nested !== null) return nested;
    }
  }
  return null;
}

function firstArray() {
  for (let i = 0; i < arguments.length; i += 1) {
    if (Array.isArray(arguments[i])) return arguments[i];
  }
  return [];
}

function firstObject() {
  for (let i = 0; i < arguments.length; i += 1) {
    const value = arguments[i];
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  }
  return {};
}

function queryParam(value, name) {
  const text = String(value || '');
  if (!text || !name) return '';
  const match = text.match(new RegExp('(?:^|[?&])' + name + '=([^&]+)', 'i'));
  if (!match) return '';
  try {
    return decodeURIComponent(match[1].replace(/\+/g, ' '));
  } catch (err) {
    return match[1];
  }
}

function normalizeUrlValue(value) {
  const text = firstString(value);
  if (!text) return '';
  if (text.indexOf('//') === 0) return 'https:' + text;
  return text;
}

function weiboUidFromUrl(value) {
  const text = normalizeUrlValue(value);
  const match = text.match(/weibo\.com\/(?:u\/)?([0-9]+)/i);
  return match ? match[1] : '';
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function dedupeByUrl(items) {
  const seen = new Set();
  return (items || []).filter((item) => {
    if (!item || !item.url || seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
}

function isImageUrl(value) {
  return /^https?:\/\/.+\.(?:avif|gif|heic|jpeg|jpg|png|webp)(?:[?#].*)?$/i.test(String(value || ''));
}

function imageFromValue(value) {
  if (!value) return null;
  if (typeof value === 'string') return { url: value };
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const url = firstString(
    value.url,
    value.url_default,
    value.urlDefault,
    value.url_pre,
    value.urlPre,
    value.url_size_large,
    value.url_size_medium,
    value.image_url,
    value.src,
    firstArray(value.url_list)[0]
  );
  if (!url) return null;
  return {
    url: url,
    width: firstNumber(value.width, value.w),
    height: firstNumber(value.height, value.h)
  };
}

function weiboPicInfoImages(item) {
  if (!item.pic_infos || typeof item.pic_infos !== 'object' || Array.isArray(item.pic_infos)) return [];
  return Object.keys(item.pic_infos).map((key) => {
    const pic = item.pic_infos[key] || {};
    const preferred = [
      pic.largest,
      pic.original,
      pic.mw2000,
      pic.large,
      pic.largecover,
      pic.bmiddle,
      pic.thumbnail
    ].map(imageFromValue).find(Boolean);
    return preferred || null;
  }).filter(Boolean);
}

function collectImages(item, platform) {
  if (String(platform || '').toLowerCase() === 'weibo') {
    const preferred = weiboPicInfoImages(item);
    if (preferred.length) return dedupeByUrl(preferred);
  }
  const images = [];
  [
    item.image_versions2 && item.image_versions2.candidates,
    item.imageVersions2 && item.imageVersions2.candidates,
    item.carousel_media && item.carousel_media.map(function(media) { return media && media.image_versions2 && media.image_versions2.candidates && media.image_versions2.candidates[0]; }),
    item.carouselMedia && item.carouselMedia.map(function(media) { return media && media.imageVersions2 && media.imageVersions2.candidates && media.imageVersions2.candidates[0]; }),
    item.image_list,
    item.images,
    item.images_list,
    item.cover && item.cover.url_list,
    item.cover && item.cover.infoList,
    item.image,
    item.image_url,
    item.profilePicture,
    item.profile_picture,
    item.profileImage,
    item.profile_image,
    item.pic_url,
    item.picture,
    item.thumbnail,
    item.sticker
  ].forEach((value) => {
    firstArray(value).forEach((entry) => {
      const image = imageFromValue(entry);
      if (image) images.push(image);
    });
    const image = imageFromValue(value);
    if (image) images.push(image);
  });
  const cover = imageFromValue(firstObject(item.cover, item.video && item.video.cover, item.note_card && item.note_card.cover));
  if (cover) images.unshift(cover);
  if (isImageUrl(item.url)) images.push({ url: item.url, width: null, height: null });
  if (item.pic_infos && typeof item.pic_infos === 'object' && !Array.isArray(item.pic_infos)) {
    Object.keys(item.pic_infos).forEach((key) => {
      const pic = item.pic_infos[key] || {};
      [
        pic.largest,
        pic.original,
        pic.large,
        pic.bmiddle,
        pic.thumbnail,
        pic.mw2000,
        pic.largecover
      ].forEach((value) => {
        const image = imageFromValue(value);
        if (image) images.push(image);
      });
    });
  }
  return dedupeByUrl(images);
}

function pickImageUrl(item, platform) {
  const image = collectImages(item, platform)[0];
  if (image) return image.url;
  return firstString(
    item.cover_url,
    item.coverUrl,
    item.profile_image_url,
    item.profileImageUrl,
    item.profilePicture,
    item.profile_picture,
    item.picture,
    item.avatar_url,
    item.avatarUrl
  );
}

function pickUrl(item) {
  const permalink = firstString(item.permalink);
  const shareInfo = firstObject(item.share_info, item.shareInfo);
  return normalizeUrlValue(firstString(
    item.url,
    item.web_url,
    item.post_url,
    item.postUrl,
    item.profile_url,
    item.profileUrl,
    item.user_url,
    item.userUrl,
    item.publicProfileUrl,
    item.public_profile_url,
    item.linkedinUrl,
    item.linkedin_url,
    item.scheme,
    item.share_url,
    item.shareUrl,
    shareInfo.share_url,
    shareInfo.shareUrl,
    shareInfo.url,
    shareInfo.link,
    item.aweme_url,
    item.note_url,
    item.arcurl,
    item.short_link,
    item.shortLink,
    item.video_url,
    item.outboundLink && item.outboundLink.url,
    permalink && permalink.startsWith('/') ? 'https://www.reddit.com' + permalink : permalink
  ));
}

// 部分平台（tiktok/douyin/小红书）搜索接口不直接返回分享 URL，只给 aweme_id/note_id + 作者 unique_id。
// 这里按各平台规则从 id 拼出可点击的来源链接，避免落库 link 为空。
function buildPlatformUrl(platform, value, user) {
  var p = String(platform || '').toLowerCase();
  user = user || {};
  var awemeId = firstString(value.aweme_id, value.video_id, value.item_id, value.id);
  var noteId = firstString(value.note_id, value.id);
  if (!noteId) noteId = firstString(value.noteId);
  var photoId = [
    value.photoId,
    queryParam(value.share_info, 'photoId'),
    queryParam(value.shareInfo, 'photoId'),
    value.photo_id
  ].map((id) => firstString(id)).find((id) => id && !/^\d+$/.test(id)) || '';
  var handle = firstString(user.unique_id, user.unique_id_str, user.uniqueId, user.short_id);
  if (p === 'tiktok' && awemeId) {
    // TikTok 视频规范地址：@用户名 段不影响跳转（按 video id 解析），缺 handle 用占位
    return 'https://www.tiktok.com/@' + (handle || 'i') + '/video/' + awemeId;
  }
  if (p === 'douyin' && awemeId) {
    return 'https://www.douyin.com/video/' + awemeId;
  }
  if ((p === 'xiaohongshu' || p === 'xhs' || p === 'redbook') && noteId) {
    return 'https://www.xiaohongshu.com/explore/' + noteId;
  }
  if (p === 'instagram') {
    var shortcode = firstString(value.code, value.shortcode, value.short_code);
    if (shortcode) return 'https://www.instagram.com/reel/' + shortcode + '/';
  }
  if (p === 'bilibili') {
    var bvid = firstString(value.bvid, value.bv_id, value.bvId);
    if (bvid) return 'https://www.bilibili.com/video/' + bvid;
    var aid = firstString(value.aid, value.archive_id, value.archiveId, /^\d+$/.test(String(value.id || '')) ? value.id : '');
    if (aid) return 'https://www.bilibili.com/video/av' + aid;
  }
  if (p === 'kuaishou' && photoId) {
    return 'https://www.kuaishou.com/short-video/' + photoId;
  }
  if (p === 'weibo') {
    var uid = firstString(user.id, user.uid, user.user_id, value.user_id, value.uid, weiboUidFromUrl(value.user_url), weiboUidFromUrl(value.userUrl));
    var postId = firstString(value.mblogid, value.mblogId, value.bid, value.weibo_id, value.weiboId, value.mid, value.id);
    if (uid && postId) return 'https://weibo.com/' + uid + '/' + postId;
  }
  if (p === 'linkedin') {
    var username = firstString(value.username, value.publicIdentifier, value.public_identifier, value.vanityName, user.username);
    if (username) return 'https://www.linkedin.com/in/' + username;
  }
  if (p === 'zhihu') {
    // 知乎搜索 answer/question 的 object.url 是 api.zhihu.com 接口地址，拼网页地址。
    var zhihuId = firstString(value.id);
    var zhihuQuestionId = firstString(value.question && value.question.id);
    if (value.type === 'answer' && zhihuId && zhihuQuestionId) {
      return 'https://www.zhihu.com/question/' + zhihuQuestionId + '/answer/' + zhihuId;
    }
    if (value.type === 'question' && zhihuId) {
      return 'https://www.zhihu.com/question/' + zhihuId;
    }
  }
  return '';
}

function chinaDateParts(now) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const parts = Object.fromEntries(formatter.formatToParts(now || new Date()).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day)
  };
}

function chinaDateIso(year, month, day, hour, minute, second) {
  const utcMs = Date.UTC(year, month - 1, day, hour - 8, minute || 0, second || 0);
  return new Date(utcMs).toISOString();
}

function parseChinesePublishedAt(value, now) {
  const text = String(value || '').trim();
  if (!text) return null;
  const base = now || new Date();
  if (/^刚刚$/.test(text)) return base.toISOString();
  // 微博实时搜索对 <1 分钟的帖子返回 "N秒前"（2026-08-18 实测 "14秒前" 等，
  // 缺失该格式曾导致 published_at 为空触发 Data Hub 急停）。
  let match = text.match(/^(\d+)\s*秒前$/);
  if (match) return new Date(base.getTime() - Number(match[1]) * 1000).toISOString();
  if (/^半小时前$/.test(text)) return new Date(base.getTime() - 1800000).toISOString();
  match = text.match(/^(\d+)\s*分钟前$/);
  if (match) return new Date(base.getTime() - Number(match[1]) * 60000).toISOString();
  match = text.match(/^(\d+)\s*小时前$/);
  if (match) return new Date(base.getTime() - Number(match[1]) * 3600000).toISOString();
  match = text.match(/^(\d+)\s*天前$/);
  if (match) return new Date(base.getTime() - Number(match[1]) * 86400000).toISOString();
  match = text.match(/^(\d+)\s*年前$/);
  if (match) return new Date(Date.UTC(base.getUTCFullYear() - Number(match[1]), base.getUTCMonth(), base.getUTCDate(), base.getUTCHours(), base.getUTCMinutes(), base.getUTCSeconds())).toISOString();
  const current = chinaDateParts(base);
  match = text.match(/^(今天|昨天|前天)\s*(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (match) {
    const offset = match[1] === '今天' ? 0 : (match[1] === '昨天' ? 1 : 2);
    const dayBase = new Date(Date.UTC(current.year, current.month - 1, current.day, 12, 0, 0));
    const shifted = new Date(dayBase.getTime() - offset * 86400000);
    return chinaDateIso(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate(), Number(match[2]), Number(match[3]), Number(match[4] || 0));
  }
  match = text.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (match) return chinaDateIso(Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6] || 0));
  match = text.match(/^(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (match) return chinaDateIso(current.year, Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5] || 0));
  return null;
}

function pickPublishedAt(item) {
  const value = item.published_at || item.publishedAt || item.publish_at || item.publish_time ||
    item.publishTime || item.published_time || item.publishedTime || item.create_time ||
    item.createTime || item.created_time || item.created_at || item.createdAt || item.created ||
    item.created_utc || item.timestamp || item.taken_at || item.takenAt ||
    item.taken_at_timestamp || item.takenAtTimestamp || item.pubdate || item.pub_date ||
    item.ctime || item.date || item.posted_at || item.postedAt || item.time;
  if (!value) return null;
  if (typeof value === 'number') {
    const milliseconds = value > 1000000000000 ? value : value * 1000;
    return new Date(milliseconds).toISOString();
  }
  const chinese = parseChinesePublishedAt(value);
  if (chinese) return chinese;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function videoFromUrl(url, meta) {
  url = firstString(url);
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) return null;
  meta = meta || {};
  return {
    url: url,
    format: /\.mp4(?:[?#]|$)/i.test(url) ? 'mp4' : firstString(meta.format, meta.video_format),
    codec: firstString(meta.video_codec, meta.codec, meta.codec_type),
    width: firstNumber(meta.width, meta.w),
    height: firstNumber(meta.height, meta.h),
    duration: firstNumber(meta.duration, meta.duration_ms),
    bitrate: firstNumber(meta.video_bitrate, meta.bitrate),
    quality: firstString(meta.quality_type, meta.quality, meta.stream_type)
  };
}

function pushVideoUrl(videos, url, meta) {
  const video = videoFromUrl(url, meta);
  if (video) videos.push(video);
}

function collectStreamVideos(value, videos, hints) {
  hints = hints || {};
  if (!value) return;
  if (Array.isArray(value)) {
    value.forEach((entry) => collectStreamVideos(entry, videos, hints));
    return;
  }
  if (typeof value === 'string') {
    pushVideoUrl(videos, value, hints);
    return;
  }
  if (typeof value !== 'object') return;

  const meta = Object.assign({}, hints, value);
  pushVideoUrl(videos, value.master_url, meta);
  pushVideoUrl(videos, value.url, meta);
  pushVideoUrl(videos, value.play_addr && firstArray(value.play_addr.url_list)[0], meta);
  firstArray(value.backup_urls).forEach((url) => pushVideoUrl(videos, url, meta));
  Object.keys(value).forEach((key) => {
    if (/url|stream/i.test(key) && typeof value[key] === 'string') {
      pushVideoUrl(videos, value[key], meta);
    }
  });
}

function collectVideos(item, platform) {
  const videos = [];
  const videoInfo = firstObject(item.video_info_v2, item.video_info, item.video);
  const media = firstObject(videoInfo.media, videoInfo);
  const video = firstObject(media.video, videoInfo.video, item.video);
  const stream = firstObject(media.stream, videoInfo.stream);
  const opaque = firstObject(video.opaque1, media.opaque1, videoInfo.opaque1);

  Object.keys(stream).forEach((key) => collectStreamVideos(stream[key], videos, {
    codec: key,
    stream_key: key
  }));
  collectStreamVideos(video, videos);
  collectStreamVideos(item.video_versions, videos);
  collectStreamVideos(item.videoVersions, videos);
  collectStreamVideos(item.video_url, videos);
  Object.keys(opaque).forEach((key) => {
    if (/stream|url/i.test(key)) pushVideoUrl(videos, opaque[key], video);
  });

  return preferredVideoVariants(dedupeByUrl(videos), platform);
}

function collectMedia(item, context) {
  return {
    images: collectImages(item, context && context.platform),
    videos: collectVideos(item, context && context.platform)
  };
}

function unwrapItem(item) {
  if (item && item.data && typeof item.data === 'object' && !Array.isArray(item.data)) {
    return Object.assign({}, item.data, {
      kind: item.kind || item.data.kind,
      wrapper_id: item.id
    });
  }
  // 知乎搜索 fetch_article_search_v3：{type:'search_result', object:{...}} 包装，
  // 真实字段都在 object 里；answer 的标题在 object.question.name。
  // 2026-08-18 之前该结构没有拆包分支，搜索只会漏出 knowledge_ad 广告卡片。
  if (item && item.type === 'search_result' && item.object && typeof item.object === 'object' && !Array.isArray(item.object)) {
    return Object.assign({}, item.object, {
      type: firstString(item.object.type, item.type),
      title: firstString(item.object.title, item.object.question && item.object.question.name),
      wrapper_id: item.id
    });
  }
  if (item && item.object && item.object.body && typeof item.object.body === 'object') {
    return Object.assign({}, item.object, item.object.body, {
      id: firstString(item.id, item.object.commodity_id, item.object.sku_id),
      type: firstString(item.type, item.object.card_type)
    });
  }
  if (item && item.note && typeof item.note === 'object') {
    return Object.assign({}, item.note, {
      model_type: item.model_type || item.note.model_type
    });
  }
  if (item && item.feed && typeof item.feed === 'object') {
    return Object.assign({}, item, item.feed, {
      type: firstString(item.type, item.itemType, item.feed.type, item.feed.photo_type, item.feed.photoType)
    });
  }
  const photo = firstObject(item && item.photo, item && item.photo_info, item && item.photoInfo);
  if (photo && Object.keys(photo).length) {
    return Object.assign({}, item, photo, {
      type: firstString(item.type, photo.type, item.card_type, photo.card_type)
    });
  }
  if (item && (item.id || item.idstr || item.mid || item.mblogid || item.aweme_id || item.note_id || item.noteId ||
    item.video_id || item.videoId || item.weibo_id || item.weiboId || item.photo_id || item.photoId || item.title || item.postTitle ||
    item.share_text || item.shareText || item.caption_text || item.captionText || item.pureTitle ||
    item.captionToComment || item.text || item.text_raw || item.desc || item.post_url || item.postUrl ||
    item.description || item.content || item.publicIdentifier || item.public_identifier || item.localizedName ||
    item.localizedFirstName || item.firstName || item.headline)) {
    return item;
  }
  // reddit dynamic search 的 {__typename, post, behaviors, telemetry} 包装：
  // 包装自身没有 id/title，真实字段都在 post 里。
  if (item && item.post && typeof item.post === 'object' && !Array.isArray(item.post) && Object.keys(item.post).length) {
    return Object.assign({}, item.post, {
      type: firstString(item.type, item.__typename, item.post.type)
    });
  }
  return firstObject(item.mblog, item.note_card, item.aweme_info, item.feed, item.photo, item.photo_info, item.photoInfo, item.video, item.item, item);
}

export function normalizeNightAllSocialItem(item, context) {
  const value = unwrapItem(item || {});
  const isCommentLike = /comment|reply/i.test(context.capability || '');
  const isUserProfile = /(user_profile|search_users?|user_followers|user_following)/i.test(context.capability || '');
  const isLocationLike = /(search_places?|search_locations?|location_)/i.test(context.capability || '');
  const content = firstObject(value.content);
  const captionObject = firstObject(value.caption);
  const user = firstObject(value.user, value.author, value.authorInfo, value.user_info, value.userInfo, value.owner, firstArray(value.authors)[0]);
  const stats = firstObject(value.stats, value.statistics, value.postStats, value.interact_info, value.interactInfo, value.counts);
  // Bilibili search fields are distinct from danmaku/coin counts. Only
  // evidence-backed video statistics are added to this platform's mapping.
  const bilibiliContent = String(context.platform || '').toLowerCase() === 'bilibili'
    && !isCommentLike && !isUserProfile && !isLocationLike;
  const bilibiliStat = bilibiliContent ? firstObject(value.stat) : {};
  const firstName = firstString(value.localizedFirstName, value.firstName, value.first_name);
  const lastName = firstString(value.localizedLastName, value.lastName, value.last_name);
  const profileName = firstString(value.localizedName, value.fullName, value.full_name, value.name) ||
    [firstName, lastName].filter(Boolean).join(' ');
  const profileUsername = firstString(value.username, value.publicIdentifier, value.public_identifier, value.vanityName, value.vanity_name);
  const locationId = firstString(value.location_id, value.locationId, value.pk, value.id);
  const locationName = firstString(value.location_name, value.locationName, value.name, value.title);

  const title = firstString(
    value.title,
    value.postTitle,
    value.displayTitle,
    value.share_text,
    value.shareText,
    value.caption_text,
    value.captionText,
    value.pureTitle,
    value.captionToComment,
    value.desc,
    value.description,
    value.content,
    captionObject.text,
    value.caption,
    value.headline,
    profileName,
    content.title,
    value.text_raw,
    value.text
  );
  const text = firstString(
    value.share_text,
    value.shareText,
    value.caption_text,
    value.captionText,
    value.pureTitle,
    value.captionToComment,
    value.desc,
    value.description,
    value.content,
    captionObject.text,
    value.headline,
    value.summary,
    value.about,
    value.bio,
    value.occupation,
    content.markdown,
    content.html,
    content.preview,
    value.selftext,
    value.text_raw,
    value.text,
    value.caption,
    value.title,
    value.postTitle,
    value.displayTitle
  );

  const explicitExternalId = firstString(
    value.cid,
    String(context.platform || '').toLowerCase() === 'reddit' && value.name,
    value.comment_id,
    value.commentId,
    value.photo_id,
    value.photoId,
    queryParam(value.share_info, 'photoId'),
    queryParam(value.shareInfo, 'photoId'),
    value.id,
    value.item_id,
    value.itemId,
    value.note_id,
    value.noteId,
    value.weibo_id,
    value.weiboId,
    value.aweme_id,
    value.awemeId,
    value.video_id,
    value.videoId,
    value.urn,
    value.post_urn,
    value.postUrn,
    value.comment_urn,
    value.commentUrn,
    value.activity_urn,
    value.activityUrn,
    isLocationLike && locationId,
    value.entityUrn,
    value.entity_urn,
    profileUsername,
    value.mblogid,
    value.mid,
    value.uid,
    item && item.id
  );
  // reddit dynamic search 的 id 是 fullname（t3_ 帖子 / t1_ 评论），历史落库为裸 base36 id，
  // 剥离前缀保持 external_id 空间一致，避免同一帖子新旧两份。
  const normalizedExternalId = String(context.platform || '').toLowerCase() === 'reddit'
    ? String(explicitExternalId || '').replace(/^t[13]_/, '')
    : explicitExternalId;
  const pickedUrl = pickUrl(value);
  const platformUrl = buildPlatformUrl(context.platform, value, user);
  const profileUrl = isUserProfile && String(context.platform || '').toLowerCase() === 'instagram' && profileUsername
    ? 'https://www.instagram.com/' + profileUsername.replace(/^@+/, '') + '/'
    : '';
  const locationUrl = isLocationLike && String(context.platform || '').toLowerCase() === 'instagram' && locationId
    ? 'https://www.instagram.com/explore/locations/' + locationId + '/'
    : '';
  const url = String(context.platform || '').toLowerCase() === 'instagram'
    ? (profileUrl || locationUrl || platformUrl || pickedUrl)
    : (String(context.platform || '').toLowerCase() === 'zhihu' && platformUrl ? platformUrl : (pickedUrl || platformUrl));
  const fallbackExternalId = '';

  return {
    platform: context.platform,
    capability: context.capability,
    source_type: firstString(value.type, value.note_type, value.media_type, value.model_type, context.capability),
    external_id: normalizedExternalId || fallbackExternalId,
    parent_external_id: isCommentLike ? firstString(
      context.parentExternalId,
      value.parent_external_id,
      value.parent_id,
      value.reply_id
    ) : '',
    root_external_id: isCommentLike ? firstString(
      context.rootExternalId,
      context.parentExternalId,
      value.root_external_id,
      value.root_id,
      value.root_comment_id
    ) : '',
    title: stripHtml(title),
    text: stripHtml(text),
    author_id: firstString(user.id, user.user_id, user.userId, user.userid, user.uid, user.sec_uid, user.channel_id, value.author_id, value.author, value.user_id, value.userId, value.uid, weiboUidFromUrl(value.user_url), weiboUidFromUrl(value.userUrl), isUserProfile && normalizedExternalId),
    author_name: firstString(user.nickname, user.nickName, user.screen_name, user.name, user.unique_id, user.username, user.display_name, value.author_name, value.author, value.user_name, value.userName, value.user_nick, value.userNick, profileName, profileUsername),
    author_avatar_url: firstString(
      user.avatar,
      user.avatar_url,
      user.avatarUrl,
      user.profile_image_url,
      user.profileImageUrl,
      user.profile_picture_url,
      user.profilePictureUrl,
      user.profile_pic_url,
      user.profilePicUrl,
      value.avatar_url,
      value.avatarUrl,
      value.profile_image_url,
      value.profileImageUrl,
      value.profile_pic_url,
      value.profilePicUrl,
      value.upic,
      value.uface,
      value.user_avatar,
      value.userAvatar,
      value.profilePicture,
      value.profile_picture,
      user.images,
      user.newIcon && user.newIcon.url,
      user.iconSmall && user.iconSmall.url,
      user.avatar_thumb && firstArray(user.avatar_thumb.url_list)[0],
      user.avatar_medium && firstArray(user.avatar_medium.url_list)[0]
    ),
    url: url,
    cover_url: pickImageUrl(value, context.platform),
    media: collectMedia(value, context),
    published_at: pickPublishedAt(value),
    like_count: firstNumber(value.like_count, value.liked_count, value.attitudes_count, value.score, stats.like_count, stats.likedCount, stats.digg_count, value.interaction && value.interaction.like_count, bilibiliContent ? value.like : null, bilibiliStat.like),
    comment_count: firstNumber(value.comment_count, value.comments_count, value.commentCount, value.num_comments, stats.comment_count, stats.commentCount, value.interaction && value.interaction.comment_count, bilibiliContent ? value.review : null, bilibiliStat.reply),
    collect_count: firstNumber(value.collect_count, value.collected_count, stats.collect_count, stats.collectCount, stats.collect_count_v2, bilibiliContent ? value.favorites : null, bilibiliStat.favorite),
    share_count: firstNumber(value.share_count, value.shared_count, value.reposts_count, stats.share_count, stats.shareCount, value.interaction && value.interaction.repost_count),
    view_count: firstMetric(
      value.view_count,
      value.viewCount,
      value.play_count,
      value.playCount,
      value.video_play_count,
      value.videoPlayCount,
      value.video_view_count,
      value.videoViewCount,
      value.read_count,
      value.readCount,
      value.reads_count,
      value.readsCount,
      value.views_count,
      value.viewsCount,
      value.views,
      value.impression_count,
      value.impressionCount,
      value.display_count,
      value.displayCount,
      stats.view_count,
      stats.viewCount,
      stats.viewCountTotal,
      stats.play_count,
      stats.playCount,
      stats.video_play_count,
      stats.videoPlayCount,
      stats.video_view_count,
      stats.videoViewCount,
      stats.read_count,
      stats.readCount,
      stats.reads_count,
      stats.readsCount,
      stats.views_count,
      stats.viewsCount,
      stats.views,
      stats.impression_count,
      stats.impressionCount,
      stats.display_count,
      stats.displayCount,
      bilibiliContent ? value.play : null,
      bilibiliStat.view
    ),
    user_id: isUserProfile ? firstString(normalizedExternalId, value.id) : '',
    user_name: isUserProfile ? profileUsername : '',
    name: isUserProfile ? firstString(profileName, profileUsername) : '',
    description: isUserProfile ? text : '',
    profile_image_url: isUserProfile ? pickImageUrl(value) : '',
    followers_count: isUserProfile ? firstNumber(value.followers_count, value.follower_count, value.followers, value.followerCount, value.followersCount) : null,
    following_count: isUserProfile ? firstNumber(value.following_count, value.following, value.followingCount) : null,
    location: isUserProfile ? firstString(value.location, value.geoLocationName, value.geo_location_name, value.country, value.city) : '',
    location_id: isLocationLike ? locationId : '',
    location_name: isLocationLike ? locationName : ''
  };
}
