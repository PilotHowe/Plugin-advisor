/**
 * Fetch the public documentation behind one catalog entry.
 *
 * npm first: `registry.npmjs.org` carries the published manifest and, for most
 * entries, the README itself. GitHub is the fallback and the source of repo
 * facts (license, default branch, last push). Both hosts are reachable from
 * the mainland network this plugin targets; raw.githubusercontent.com and
 * cdn.jsdelivr.net were measured unreachable and are deliberately unused.
 */

const DOC_TTL_MS = 10 * 60 * 1000;
const REPO_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15 * 1000;

const docCache = new Map();
const repoCache = new Map();

/** Parse a GitHub repository URL, including /tree/<branch>/<subpath>. */
export function parseRepo(url) {
  const match = /^https?:\/\/github\.com\/([^/?#]+)\/([^/?#]+)(?:\/tree\/([^/?#]+)(?:\/(.+?))?)?\/?(?:[?#].*)?$/i.exec(String(url ?? ''));
  if (match === null) return null;
  return {
    owner: match[1],
    repo: match[2].replace(/\.git$/i, ''),
    branch: match[3] ?? null,
    subpath: match[4] ? match[4].replace(/\/+$/, '') : null,
  };
}

/** Load and cache everything the inspect and guide tools need for one entry. */
export async function loadDocs(entry, options = {}) {
  const includeReadme = options.includeReadme !== false;
  const key = `${entry.name}|${includeReadme ? 'readme' : 'meta'}`;
  const cached = docCache.get(key);
  if (cached !== undefined && Date.now() - cached.fetchedAt < DOC_TTL_MS) return cached;

  const sources = [];
  const errors = [];
  let npm = null;
  let repoFacts = null;
  let readme = null;
  let readmeSource = 'none';

  const repo = parseRepo(entry.url);
  if (entry.npm) {
    try {
      npm = await npmManifest(entry.npm);
      sources.push(`https://registry.npmjs.org/${entry.npm}/latest`);
      if (typeof npm.readme === 'string' && npm.readme.trim() !== '') {
        readme = npm.readme;
        readmeSource = 'npm';
      }
    } catch (error) {
      errors.push(`npm: ${errorMessage(error)}`);
    }
  }

  if (repo !== null) {
    try {
      repoFacts = await getRepoFacts(repo, options.githubToken);
      sources.push(`https://api.github.com/repos/${repo.owner}/${repo.repo}`);
    } catch (error) {
      errors.push(`github-repo: ${errorMessage(error)}`);
    }
  }

  if (includeReadme && readme === null && repo !== null) {
    try {
      const result = await githubReadme(repo, options.githubToken);
      if (result !== null) {
        readme = result.text;
        readmeSource = 'github';
        sources.push(result.url);
      }
    } catch (error) {
      errors.push(`github-readme: ${errorMessage(error)}`);
    }
  }

  const doc = extractDoc(readme ?? '');
  const value = {
    entry,
    npm,
    repo,
    repoFacts,
    readme,
    readmeSource,
    doc,
    sources,
    errors,
    fetchedAt: Date.now(),
  };
  docCache.set(key, value);
  return value;
}

/** Facts about a GitHub repository, cached for an hour. */
export async function getRepoFacts(repo, token) {
  const key = `${repo.owner}/${repo.repo}`;
  const cached = repoCache.get(key);
  if (cached !== undefined && Date.now() - cached.at < REPO_TTL_MS) return cached.value;
  const data = await githubJson(`https://api.github.com/repos/${key}`, token);
  const value = {
    fullName: data.full_name ?? key,
    htmlUrl: data.html_url ?? `https://github.com/${key}`,
    description: typeof data.description === 'string' ? data.description : null,
    license: data.license && typeof data.license.spdx_id === 'string' ? data.license.spdx_id : null,
    defaultBranch: data.default_branch ?? null,
    pushedAt: data.pushed_at ?? null,
    archived: data.archived === true,
    fork: data.fork === true,
    parent: data.parent && typeof data.parent.full_name === 'string' ? data.parent.full_name : null,
    stars: typeof data.stargazers_count === 'number' ? data.stargazers_count : null,
    openIssues: typeof data.open_issues_count === 'number' ? data.open_issues_count : null,
  };
  repoCache.set(key, { at: Date.now(), value });
  return value;
}

/** The npm manifest at the latest tag. */
export async function npmManifest(pkg) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`;
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'dsh-plugin-advisor' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  return {
    version: typeof data.version === 'string' ? data.version : null,
    description: typeof data.description === 'string' ? data.description : null,
    readme: typeof data.readme === 'string' ? data.readme : null,
    license: typeof data.license === 'string' ? data.license : null,
    repository: typeof data.repository === 'string'
      ? data.repository
      : data.repository && typeof data.repository.url === 'string'
        ? data.repository.url
        : null,
    dsh: data.dsh && typeof data.dsh === 'object' ? data.dsh : null,
    engines: data.engines && typeof data.engines === 'object' ? data.engines : null,
    keywords: Array.isArray(data.keywords) ? data.keywords.filter((item) => typeof item === 'string') : [],
  };
}

async function githubReadme(repo, token) {
  const ref = repo.branch;
  const candidates = [];
  if (repo.subpath !== null) {
    const path = `${repo.subpath.replace(/^\/+/, '')}/README.md`;
    candidates.push(`https://api.github.com/repos/${repo.owner}/${repo.repo}/contents/${encodePath(path)}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`);
  }
  candidates.push(`https://api.github.com/repos/${repo.owner}/${repo.repo}/readme${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`);

  let lastError = null;
  for (const url of candidates) {
    try {
      const data = await githubJson(url, token);
      const text = decodeGithubContent(data);
      if (text !== null && text.trim() !== '') {
        return { text, url: data.html_url ?? url };
      }
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError !== null) throw lastError;
  return null;
}

async function githubJson(url, token) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'dsh-plugin-advisor' };
  if (typeof token === 'string' && token !== '') headers.authorization = `Bearer ${token}`;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) {
    if (response.status === 403 || response.status === 429) {
      const remaining = response.headers.get('x-ratelimit-remaining');
      throw new Error(`GitHub API 限流（HTTP ${response.status}，剩余 ${remaining ?? '未知'}）；可设置 PLUGIN_ADVISOR_GITHUB_TOKEN`);
    }
    throw new Error(`HTTP ${response.status}`);
  }
  return await response.json();
}

function decodeGithubContent(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.encoding === 'base64' && typeof data.content === 'string') {
    try {
      return Buffer.from(data.content, 'base64').toString('utf8');
    } catch {
      return null;
    }
  }
  return typeof data.content === 'string' ? data.content : null;
}

function encodePath(path) {
  return path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

/**
 * Split a README into a summary, classified sections, and code blocks.
 * Returns empty fields rather than guessing when the text has no such section.
 */
export function extractDoc(text) {
  const source = String(text ?? '')
    .replace(/\r\n/gu, '\n')
    .replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/<sub\b[^>]*>[\s\S]*?<\/sub>/giu, '');
  const lines = source.split('\n');
  const sections = [];
  let current = { level: 0, title: '', lines: [] };
  const flush = () => {
    const body = current.lines.join('\n').trim();
    if (current.title !== '' || body !== '') {
      sections.push({ level: current.level, title: current.title, body });
    }
  };
  for (const line of lines) {
    const heading = /^(#{1,4})\s+(.+?)\s*#*\s*$/u.exec(line);
    if (heading !== null) {
      flush();
      current = { level: heading[1].length, title: heading[2].trim(), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  flush();

  const headings = sections.map((section) => section.title).filter((title) => title !== '');
  const classified = {
    install: '',
    usage: '',
    config: '',
    requirements: '',
    troubleshoot: '',
    uninstall: '',
  };
  for (const section of sections) {
    const kind = classifyHeading(section.title);
    if (kind !== null && classified[kind] === '') classified[kind] = section.body;
  }

  const codeBlocks = [];
  let fenced = false;
  let language = '';
  let body = [];
  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      if (fenced) {
        const code = body.join('\n').trim();
        if (code !== '') codeBlocks.push({ language, code: code.slice(0, 4000) });
        fenced = false;
        body = [];
      } else {
        fenced = true;
        language = line.trim().slice(3).trim().split(/\s+/u)[0] ?? '';
      }
      continue;
    }
    if (fenced) body.push(line);
  }

  const preamble = sections.find((section) => section.title === '')?.body ?? '';
  const summary = firstParagraph(preamble)
    || sections.map((section) => firstParagraph(section.body)).find((value) => value !== '')
    || '';

  return {
    summary,
    sections,
    headings,
    classified,
    codeBlocks,
    length: source.length,
    hasReadme: source.trim() !== '',
  };
}

/** Small, model-facing facts about how complete the documentation is. */
export function docsFacts(doc) {
  return {
    hasReadme: doc.hasReadme,
    hasInstall: doc.classified.install !== '',
    hasUsage: doc.classified.usage !== '',
    hasExamples: doc.codeBlocks.length > 0,
    hasConfig: doc.classified.config !== '',
    chars: doc.length,
  };
}

function classifyHeading(title) {
  const value = String(title ?? '').toLowerCase();
  if (/install|安装|setup|getting started|快速开始|开始使用|接入|部署/u.test(value)) return 'install';
  if (/usage|使用|quick ?start|example|示例|怎么用|上手/u.test(value)) return 'usage';
  if (/config|配置|environment|环境变量|setting|设置|参数/u.test(value)) return 'config';
  if (/require|prerequisite|依赖|前置|before you start|需要|准备工作/u.test(value)) return 'requirements';
  if (/troubleshoot|faq|常见问题|排错|known issue|问题/u.test(value)) return 'troubleshoot';
  if (/uninstall|卸载|remove/u.test(value)) return 'uninstall';
  return null;
}

function firstParagraph(text) {
  const lines = String(text ?? '').split('\n');
  const paragraph = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') {
      if (paragraph.length > 0) break;
      continue;
    }
    if (line.startsWith('#') || line.startsWith('[![') || line.startsWith('![')) {
      if (paragraph.length > 0) break;
      continue;
    }
    if (/^<(?:sub|p|div|img|picture|source|details|summary)\b/iu.test(line)) {
      continue;
    }
    const plain = line
      .replace(/<[^>]*>/gu, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/gu, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
      .replace(/[*`~]/gu, '')
      .trim();
    if (plain === '' || /^english\s*\|/iu.test(plain)) {
      continue;
    }
    if (/^(?:english|简体中文|繁體中文|中文)\s*(?:\||$)/iu.test(plain)) {
      continue;
    }
    paragraph.push(plain);
    if (paragraph.join(' ').length >= 400) break;
  }
  return paragraph.join(' ').slice(0, 400);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
