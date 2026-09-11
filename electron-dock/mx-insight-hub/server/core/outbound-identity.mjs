// How Hub identifies itself to upstream providers.
//
// Node's fetch otherwise sends `User-Agent: node`. Providers front their APIs
// with bot protection that rejects unrecognised runtime defaults -- TikHub's
// Cloudflare rule is documented to reject Python's default the same way -- so
// every outbound provider call names Hub honestly.
//
// This identifies the caller. It deliberately does not imitate a browser:
// Hub is a paying API customer, and a spoofed browser string would be evading
// the provider's protection rather than cooperating with it. If an honest
// identity is still blocked, that is a conversation with the provider.
export const HUB_USER_AGENT = 'mx-insight-hub/1.0 (+https://hub.minsight-ai.com)'
