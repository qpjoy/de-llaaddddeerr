export interface PackageManifestFile {
  path: string;
  sha256: string;
}

export interface PackageManifest {
  schemaVersion: 1;
  productId: string;
  generatedAt: string;
  signerThumbprint: string | null;
  files: PackageManifestFile[];
}

export function findPackageFile(manifest: PackageManifest, path: string): PackageManifestFile | null {
  return manifest.files.find((file) => file.path === path) ?? null;
}
