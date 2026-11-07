/**
 * X1: the non-default map packages' file URLs (docs/maps.md), found at build time: whatever `data/maps/<id>/` holds.
 * A package that isn't built yet (Valve's files not extracted) has no entries, and loading it fails with a clear
 * message. Shared by the 2D and 3D asset loaders (the default package's files are their own static imports).
 */
import { mapPackagePaths, type MapId } from '../contracts/index';

const PACKAGE_URLS = import.meta.glob<string>('../../data/maps/*/*.{bin,json,png}', { query: '?url', import: 'default', eager: true });

/** The URL of a package file (repo-relative path), or an error naming what's missing. */
export function packageUrl(path: string, map: MapId): string {
  const url = PACKAGE_URLS[`../../${path}`];
  if (url === undefined) throw new Error(`map package "${map}" isn't built: ${path} is missing (docs/maps.md)`);
  return url;
}

/** The 3D world's file URLs of a non-default package (H3: `tracks` is '' for a package without a recording). */
export function packageWorldUrls(map: MapId): { geometry: string; clips: string; tracks: string } {
  const p = mapPackagePaths(map);
  const tracks = PACKAGE_URLS[`../../${p.tracks}`] ?? '';
  return { geometry: packageUrl(p.geometry, map), clips: packageUrl(p.clips, map), tracks };
}
