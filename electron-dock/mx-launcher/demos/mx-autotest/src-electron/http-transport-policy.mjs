export function assertHttpBearerTransport(baseUrl) {
  const target = new URL(baseUrl);
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error('Bearer transport must use HTTP(S)');
  }
}
