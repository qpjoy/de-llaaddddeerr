import { existsSync, readFileSync, realpathSync } from 'fs';
import { createRequire } from 'module';
import { dirname, join } from 'path';

function vendoredPackageDir(packageDir: string, dep: string): string | null {
  const parts = dep.startsWith('@') ? dep.split('/').slice(1) : [dep];
  const name = parts[0];
  if (!name) return null;
  return join(packageDir, 'dist', 'vendor', name);
}

function hasVendoredDependency(packageDir: string, dep: string): boolean {
  const vendorDir = vendoredPackageDir(packageDir, dep);
  if (!vendorDir) return false;

  const vendorPkgPath = join(vendorDir, 'package.json');
  if (!existsSync(vendorPkgPath)) return false;

  try {
    const pkg = JSON.parse(readFileSync(vendorPkgPath, 'utf8')) as {
      name?: string;
      main?: string;
    };
    if (pkg.name !== dep) return false;

    const requireFromVendor = createRequire(vendorPkgPath);
    try {
      requireFromVendor.resolve(vendorDir);
      return true;
    } catch {
      return existsSync(join(vendorDir, pkg.main ?? 'index.js'));
    }
  } catch {
    return false;
  }
}

export function missingPluginPackageDependencies(
  pkgJsonPath: string,
  dependencies: Record<string, string>
): string[] {
  const realPkgJsonPath = realpathSync(pkgJsonPath);
  const packageDir = dirname(realPkgJsonPath);
  const requireFromPlugin = createRequire(realPkgJsonPath);
  const missing: string[] = [];

  for (const dep of Object.keys(dependencies)) {
    try {
      requireFromPlugin.resolve(dep);
      continue;
    } catch {
      if (hasVendoredDependency(packageDir, dep)) continue;
      missing.push(dep);
    }
  }

  return missing;
}
