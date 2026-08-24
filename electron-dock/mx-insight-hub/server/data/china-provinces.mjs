// Stable province-level taxonomy for public-opinion serving.
// Codes follow ISO 3166-2:CN.  Unknown source text deliberately returns null:
// an unclassified item must not be made to look like a national/province fact.
const PROVINCES = Object.freeze([
  ['CN-BJ', '北京', '北京市'],
  ['CN-TJ', '天津', '天津市'],
  ['CN-HE', '河北', '河北省'],
  ['CN-SX', '山西', '山西省'],
  ['CN-NM', '内蒙古', '内蒙古自治区'],
  ['CN-LN', '辽宁', '辽宁省'],
  ['CN-JL', '吉林', '吉林省'],
  ['CN-HL', '黑龙江', '黑龙江省'],
  ['CN-SH', '上海', '上海市'],
  ['CN-JS', '江苏', '江苏省'],
  ['CN-ZJ', '浙江', '浙江省'],
  ['CN-AH', '安徽', '安徽省'],
  ['CN-FJ', '福建', '福建省'],
  ['CN-JX', '江西', '江西省'],
  ['CN-SD', '山东', '山东省'],
  ['CN-HA', '河南', '河南省'],
  ['CN-HB', '湖北', '湖北省'],
  ['CN-HN', '湖南', '湖南省'],
  ['CN-GD', '广东', '广东省'],
  ['CN-GX', '广西', '广西壮族自治区'],
  ['CN-HI', '海南', '海南省'],
  ['CN-CQ', '重庆', '重庆市'],
  ['CN-SC', '四川', '四川省'],
  ['CN-GZ', '贵州', '贵州省'],
  ['CN-YN', '云南', '云南省'],
  ['CN-XZ', '西藏', '西藏自治区'],
  ['CN-SN', '陕西', '陕西省'],
  ['CN-GS', '甘肃', '甘肃省'],
  ['CN-QH', '青海', '青海省'],
  ['CN-NX', '宁夏', '宁夏回族自治区'],
  ['CN-XJ', '新疆', '新疆维吾尔自治区'],
  ['CN-TW', '台湾', '台湾省'],
  ['CN-HK', '香港', '香港特别行政区'],
  ['CN-MO', '澳门', '澳门特别行政区'],
].map(([code, name, officialName]) => Object.freeze({ code, name, officialName })))

export const CHINA_PROVINCES = PROVINCES

const ALIASES = new Map(PROVINCES.flatMap((province) => [
  [province.code.toUpperCase(), province],
  [province.name, province],
  [province.officialName, province],
]))

export function normalizeChinaProvince(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text) return null
  return ALIASES.get(text.toUpperCase()) ?? ALIASES.get(text) ?? null
}
