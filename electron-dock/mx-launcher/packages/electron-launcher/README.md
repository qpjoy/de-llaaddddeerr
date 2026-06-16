# @qpjoy/electron-launcher

Product-facing npm entry for MX Launcher.

Applications install this package directly and point it at an MX Launcher
backend. The package hides the internal split between core, embed, and
standalone adapters.

```ts
import { createElectronLauncher, defineLauncherProduct } from '@qpjoy/electron-launcher';

export const product = defineLauncherProduct({
  productId: 'h2o',
  displayName: 'H2O',
  mode: 'embed',
  launcherActions: {
    network: true,
    release: true,
    update: true,
    rollout: true,
    appCenter: true
  }
});

const launcher = createElectronLauncher({
  baseUrl: 'http://127.0.0.1:18090',
  productId: product.productId,
  mode: product.mode
});

const session = await launcher.connectNetwork({
  identityKind: 'anonymous',
  deviceLabel: 'H2O Desktop'
});

// Persist session.wireGuard.privateKey in the product's secure storage, then
// apply session.routePlan through the product's WireGuard/runtime adapter.
const routePlan = session.routePlan;
```

`standalone` mode is for the full Launcher shell. `embed` mode is for product
apps that carry Launcher network capability inside the app.
