/**
 * Community catalog access for the plugin buddy.
 *
 * The catalog's own host (GitHub Pages) is slow enough to stall a 12 MB body
 * from this network, while the npm registry answers in seconds. The market
 * solved the same problem years ago by publishing the same file as the
 * `dsh-plugin-catalog` package; this module reads that tarball and extracts
 * `plugins.json` with Node's own zlib, so no dependency is needed.
 *
 * Like the market, this module refuses a bundled snapshot: for a catalog that
 * grows daily, a stale answer reads as "does not exist". A short in-memory
 * cache is allowed because every consumer lives in the same process.
 */

import { gunzipSync } from 'node:zlib';

const DEFAULT_PACKAGE = 'dsh-plugin-catalog';
const DEFAULT_URL = 'https://awesome-dsh-plugin.com/plugins.json';
const CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_STALE_MS = 6 * 60 * 60 * 1000;
const META_TIMEOUT_MS = 20 * 1000;
const TARBALL_TIMEOUT_MS = 60 * 1000;
const JSON_TIMEOUT_MS = 25 * 1000;

/** @type {{ entries: object[], count: number, updated: string | null, fetchedAt: number, source: string } | null} */
let cache = null;
/** @type {Promise<object> | null} */
let inflight = null;

/**
 * Resolve where the catalog comes from. An explicit URL wins (operator
 * override or the market's own environment variable); otherwise the npm
 * package that carries the same file.
 */
export function resolveCatalogSource(config = {}) {
  const value = config && typeof config === 'object' ? config : {};
  const fromConfig = typeof value.catalogUrl === 'string' ? value.catalogUrl.trim() : '';
  if (fromConfig) return { kind: 'url', url: fromConfig };
  const fromEnv = (process.env.PLUGIN_ADVISOR_CATALOG_URL || process.env.DSHM_REGISTRY_URL || '').trim();
  if (fromEnv) return { kind: 'url', url: fromEnv };
  const pkg = typeof value.catalogPackage === 'string' && value.catalogPackage.trim() !== ''
    ? value.catalogPackage.trim()
    : DEFAULT_PACKAGE;
  return { kind: 'npm', package: pkg };
}

/** Entries already in memory, or null when nothing is warm yet. */
export function peekCatalog() {
  return cache === null ? null : cache.entries;
}

/** Facts about the current in-memory catalog, or null when cold. */
export function catalogFacts() {
  if (cache === null) return null;
  return {
    count: cache.count,
    updated: cache.updated,
    fetchedAt: cache.fetchedAt,
    source: cache.source,
    ageMs: Date.now() - cache.fetchedAt,
  };
}

/**
 * Return the catalog, fetching it when the cache is cold, expired, or a
 * different source is requested. On failure a cache younger than six hours is
 * returned with `stale: true` and the failure attached.
 *
 * @param {{ source?: object, force?: boolean }} [options]
 */
export async function ensureCatalog(options = {}) {
  const source = options.source ?? { kind: 'npm', package: DEFAULT_PACKAGE };
  const label = sourceLabel(source);
  const fresh = cache !== null
    && cache.source === label
    && Date.now() - cache.fetchedAt < CACHE_TTL_MS;
  if (!options.force && fresh) return cache;
  if (inflight !== null) return await inflight;
  const task = load(source).then((value) => {
    cache = value;
    return value;
  }).catch((error) => {
    if (cache !== null && Date.now() - cache.fetchedAt <= MAX_STALE_MS) {
      return {
        ...cache,
        stale: true,
        staleSince: cache.fetchedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    throw error;
  });
  inflight = task;
  try {
    return await task;
  } finally {
    if (inflight === task) inflight = null;
  }
}

function sourceLabel(source) {
  return source.kind === 'npm' ? `npm:${source.package}` : `url:${source.url}`;
}

async function load(source) {
  if (source.kind === 'npm') {
    try {
      return await loadFromNpmPackage(source.package);
    } catch (primaryError) {
      // The market keeps the origin as the route that "has always worked".
      try {
        return await loadFromJson(DEFAULT_URL, `url:${DEFAULT_URL}`);
      } catch (fallbackError) {
        throw new Error(
          `无法读取插件目录：npm 包 ${source.package}（${errorMessage(primaryError)}）；`
          + `${DEFAULT_URL}（${errorMessage(fallbackError)}）。可设置 PLUGIN_ADVISOR_CATALOG_URL 指向镜像。`,
        );
      }
    }
  }
  return loadFromJson(source.url, sourceLabel(source));
}

async function loadFromNpmPackage(pkg) {
  const meta = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`, META_TIMEOUT_MS);
  const tarball = meta && meta.dist && typeof meta.dist.tarball === 'string' ? meta.dist.tarball : null;
  if (tarball === null) throw new Error('npm 元数据里没有 dist.tarball');
  const buffer = await fetchBuffer(tarball, TARBALL_TIMEOUT_MS);
  const entry = extractTarEntry(buffer, 'package/plugins.json');
  const data = JSON.parse(entry.toString('utf8'));
  return projectCatalog(data, `npm:${pkg}@${typeof meta.version === 'string' ? meta.version : 'latest'}`);
}

async function loadFromJson(url, label) {
  const data = await fetchJson(url, JSON_TIMEOUT_MS);
  return projectCatalog(data, label);
}

function projectCatalog(data, label) {
  if (!data || !Array.isArray(data.plugins) || data.plugins.length === 0) {
    throw new Error('catalog contains no plugins');
  }
  return {
    entries: data.plugins.map(projectEntry).filter((entry) => entry.name !== ''),
    count: data.plugins.length,
    updated: typeof data.updated === 'string' ? data.updated : null,
    fetchedAt: Date.now(),
    source: label,
  };
}

/** Keep only the fields every tool needs, so the 12 MB source can be collected. */
function projectEntry(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const categories = Array.isArray(value.category)
    ? value.category.filter((item) => typeof item === 'string')
    : typeof value.category === 'string'
      ? [value.category]
      : [];
  const description = value.description && typeof value.description === 'object'
    ? Object.fromEntries(
      Object.entries(value.description).filter(([, text]) => typeof text === 'string' && text !== ''),
    )
    : {};
  const releaseManifest = value.releaseManifest && typeof value.releaseManifest === 'object'
    ? value.releaseManifest
    : null;
  return {
    name: typeof value.name === 'string' ? value.name : '',
    owner: typeof value.owner === 'string' ? value.owner : '',
    url: typeof value.url === 'string' ? value.url : '',
    npm: typeof value.npm === 'string' ? value.npm : null,
    categories,
    description,
    stars: finiteOrNull(value.stars),
    downloads: finiteOrNull(value.downloads),
    added: typeof value.added === 'string' ? value.added : null,
    version: typeof value.version === 'string' ? value.version : null,
    install: typeof value.install === 'string' ? value.install : null,
    deprecated: value.deprecated === true,
    replacement: typeof value.replacement === 'string' ? value.replacement : null,
    capabilities: stringArray(value.capabilities),
    capabilityRedLines: stringArray(value.capabilityRedLines),
    enginesDsh: typeof value.enginesDsh === 'string'
      ? value.enginesDsh
      : releaseManifest && typeof releaseManifest.enginesDsh === 'string'
        ? releaseManifest.enginesDsh
        : null,
    releaseManifest,
  };
}

/** Read one regular file out of a gzipped tar without a tar dependency. */
export function extractTarEntry(gzipped, wanted) {
  const tar = gunzipSync(gzipped);
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = readString(header, 0, 100);
    const size = Number.parseInt(readString(header, 124, 12).trim() || '0', 8);
    const type = header[156];
    const dataStart = offset + 512;
    if (name === wanted && (type === 0 || type === 48)) {
      return tar.subarray(dataStart, dataStart + size);
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  throw new Error(`tarball 中找不到 ${wanted}`);
}

function readString(buffer, start, length) {
  const slice = buffer.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8').trim();
}

async function fetchJson(url, timeoutMs) {
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'dsh-plugin-buddy' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
  return await response.json();
}

async function fetchBuffer(url, timeoutMs) {
  const response = await fetch(url, {
    headers: { accept: '*/*', 'user-agent': 'dsh-plugin-buddy' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
  return Buffer.from(await response.arrayBuffer());
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : null;
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
