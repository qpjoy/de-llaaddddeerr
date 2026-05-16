/**
 * Standalone entrypoint. Most consumers will install this via the
 * marketplace (`dist/plugin.js` adapter); the standalone factory below
 * is here so apps that don't run the marketplace host can still drop the
 * ball in with two lines of code in their main process.
 */
export {
  createOverlayManager,
  type OverlayManagerHandle,
  type CreateOverlayManagerOptions
} from './overlay/createOverlayManager';
