import manifest from '../../package.json' with { type: 'json' }

// Desktop packaging, Internal and MCP all identify the same Rig release.
export const PRODUCT_VERSION = manifest.version
