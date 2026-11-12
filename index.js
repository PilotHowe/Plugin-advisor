/**
 * Plugin advisor: intent search, quality facts, onboarding guides, and an
 * optional proactive hint on every user instruction.
 *
 * The plugin is deliberately dependency-free: no Harness package imports, no
 * build step, plain ESM. That keeps a bad load from taking the Host down and
 * lets the profile link this directory directly.
 */

import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureCatalog, peekCatalog, resolveCatalogSource } from './lib/catalog.js';
import { searchEntries } from './lib/search.js';
import { loadDocs } from './lib/docs.js';
import { buildGuide } from './lib/guide.js';
import { formatGuide, formatInspect, formatSearch } from './lib/format.js';
import { buildHint, hintNames, hintQuery, messageText, shouldHint } from './lib/hint.js';

export const name = 'plugin-advisor';
export const inject = ['tools', 'skills', 'systemPrompt'];

const SKILL_FALLBACK = [
  'Use plugin_search to find community plugins, plugin_inspect to judge one, and plugin_guide for grounded onboarding steps.',
  'Search with 2-5 short Chinese and English keyword groups; never recommend a plugin whose README has not been checked.',
  'Never install without the user seeing the source and capability disclosure; hand installation to plugin_manager.',
].join('\n');

let skillContent = SKILL_FALLBACK;
try {
  skillContent = readFileSync(new URL('./skill.md', import.meta.url), 'utf8');
} catch {
  // A missing skill.md keeps the plugin usable through the tools alone.
}

const TOOL_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string' } },
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
};

export function apply(ctx, config = {}) {
  const settings = normalizeSettings(config);
  if (settings.proactive) void ensureCatalog({ source: settings.catalogSource }).catch(() => {});

  let active = true;
  let hints = new WeakMap();
  const sessionOverrides = new Map();
  const perAgent = new Map();
  const cooldown = new Map();
  const lastHintNames = new Map();

  registerTools(ctx, settings);
  registerSkill(ctx);
  registerCommand(ctx, settings);
  registerProactive(ctx, settings);

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      active = false;
      for (const dispose of perAgent.values()) {
        try {
          dispose();
        } catch {
          // A disposed agent context is already gone.
        }
      }
      perAgent.clear();
      hints = new WeakMap();
    });
  }

  function registerTools(pluginCtx, options) {
    pluginCtx.tools.register({
      name: 'plugin_search',
      description: [
        'Search the DeepSeek Harness community plugin catalog (10,000+ entries) by intent.',
        'Pass 2-5 paraphrased keyword groups, Chinese and English, not whole sentences.',
        'Returns ranked candidates with quality facts, capabilities, deprecation, install spec, and why each matched.',
        'Use it before recommending or installing any community plugin, or when a task\'s core outcome may be better served by one; it searches the market, not locally installed plugins.',
      ].join(' '),
      parameters: {
        queries: {
          type: 'array',
          required: true,
          description: '1-5 keyword groups. Prefer 2-4 short groups mixing Chinese and English.',
          items: { type: 'string' },
        },
        limit: {
          type: 'integer',
          description: 'Maximum results, default 6, at most 12.',
        },
        category: {
          type: 'string',
          description: 'Optional catalog category id or label filter.',
        },
        capability: {
          type: 'string',
          description: 'Optional capability filter, such as shell, network, credentials, fs-read, or llm.',
        },
        excludeDeprecated: {
          type: 'boolean',
          description: 'Skip deprecated entries, default true.',
        },
        refresh: {
          type: 'boolean',
          description: 'Force a fresh catalog read instead of the 30-minute cache.',
        },
      },
      output: TOOL_OUTPUT,
      async execute(args) {
        const queries = normalizeQueries(args?.queries);
        if (queries.length === 0) throw new Error('queries 至少需要一组关键词，建议 2-4 组中英混合关键词');
        const catalog = await ensureCatalog({ source: options.catalogSource, force: args?.refresh === true });
        const { results, matchedCount } = searchEntries(catalog.entries, queries, {
          limit: args?.limit,
          category: args?.category,
          capability: args?.capability,
          excludeDeprecated: args?.excludeDeprecated !== false,
        });
        return {
          text: formatSearch({
            facts: factsOf(catalog),
            results,
            matchedCount,
            queries,
            stale: catalog.stale === true,
          }),
        };
      },
    });

    pluginCtx.tools.register({
      name: 'plugin_inspect',
      description: [
        'Read one community plugin in depth: identity, repository, license, host requirement, capabilities, documentation completeness, README sections and code blocks, and similar alternatives.',
        'Also reports what building on top of it would involve (repository, license, patch path, package manifest facts).',
        'Use it on the top 1-3 candidates from plugin_search before making a recommendation.',
      ].join(' '),
      parameters: {
        name: {
          type: 'string',
          required: true,
          description: 'Exact plugin name, npm package name, or catalog URL returned by plugin_search.',
        },
        includeReadme: {
          type: 'boolean',
          description: 'Fetch and include README content when the manifest has none, default true.',
        },
        readmeChars: {
          type: 'integer',
          description: 'README excerpt length in characters, default 1200, at most 4000.',
        },
      },
      output: TOOL_OUTPUT,
      async execute(args) {
        const catalog = await ensureCatalog({ source: options.catalogSource });
        const entry = findEntry(catalog.entries, args?.name);
        if (entry === null) throw new Error(notFoundMessage(catalog.entries, args?.name));
        const docs = await loadDocs(entry, {
          includeReadme: args?.includeReadme !== false,
          githubToken: options.githubToken,
        });
        return {
          text: formatInspect(docs, {
            readmeChars: readmeCharsOf(args?.readmeChars, options),
          }),
        };
      },
    });

    pluginCtx.tools.register({
      name: 'plugin_guide',
      description: [
        'Produce a grounded onboarding draft for one community plugin: what it does, prerequisites, setup steps, configuration, examples, verification, troubleshooting, uninstall, and explicit documentation gaps.',
        'Every step comes from the README or the package manifest; never invent steps the sources do not contain.',
        'Use it after plugin_inspect has picked the plugin to recommend.',
      ].join(' '),
      parameters: {
        name: {
          type: 'string',
          required: true,
          description: 'Exact plugin name, npm package name, or catalog URL returned by plugin_search.',
        },
        goal: {
          type: 'string',
          description: 'Optional user goal, used to pick the most relevant examples and steps.',
        },
      },
      output: TOOL_OUTPUT,
      async execute(args) {
        const catalog = await ensureCatalog({ source: options.catalogSource });
        const entry = findEntry(catalog.entries, args?.name);
        if (entry === null) throw new Error(notFoundMessage(catalog.entries, args?.name));
        const docs = await loadDocs(entry, { includeReadme: true, githubToken: options.githubToken });
        const guide = buildGuide(entry, docs, { profile: options.profile });
        return { text: formatGuide(guide) };
      },
    });
  }

  function registerSkill(pluginCtx) {
    try {
      pluginCtx.skills.register({
        name: 'plugin-advisor',
        description: 'Find, reuse, compare, install, and learn to use community plugins from a task description, without browsing the market or guessing keywords; also decides when a task is better served by a plugin and asks before switching.',
        whenToUse: 'Use when a user task may be better served by a community plugin (documents, OCR, spreadsheets, browser automation, scheduling, notifications, data), or when the user wants to find, compare, choose, install, or learn to use a DSH plugin, or build on one.',
        content: skillContent,
        source: 'runtime',
        invocation: { modelInvocable: true, userInvocable: true },
      });
    } catch (error) {
      pluginCtx.logger?.warn?.(`plugin-advisor: skill registration failed: ${errorMessage(error)}`);
    }
  }

  function registerCommand(pluginCtx, options) {
    const commands = pluginCtx.get?.('commands');
    if (commands === undefined || commands === null || typeof commands.register !== 'function') return;
    try {
      commands.register({
        name: 'plugin-hint',
        description: '插件顾问：开启/关闭本会话的主动插件推荐（on | off | status）。',
        handler: (invocation) => {
          const agent = invocation?.agent;
          const raw = String(invocation?.rawInput ?? '').trim().toLowerCase();
          const key = agent ? String(agent.id) : null;
          if (raw === 'status' || raw === '状态') {
            const enabled = agent ? isProactive(agent) : options.proactive;
            const source = key !== null && sessionOverrides.has(key) ? '本会话覆盖' : '配置默认';
            return { kind: 'success', text: `插件顾问主动提示：${enabled ? '开' : '关'}（${source}）。` };
          }
          if (raw === '' || raw === 'toggle') {
            const next = agent ? !isProactive(agent) : !options.proactive;
            if (key !== null) sessionOverrides.set(key, next);
            return { kind: 'success', text: `插件顾问主动提示：${next ? '已开启' : '已关闭'}（本会话）。发送 /plugin-hint status 查看。` };
          }
          if (raw === 'on' || raw === 'off') {
            const next = raw === 'on';
            if (key !== null) sessionOverrides.set(key, next);
            return { kind: 'success', text: `插件顾问主动提示：${next ? '已开启' : '已关闭'}（本会话）。` };
          }
          return { kind: 'error', text: '用法：/plugin-hint on | off | status' };
        },
      });
    } catch (error) {
      pluginCtx.logger?.warn?.(`plugin-advisor: command registration failed: ${errorMessage(error)}`);
    }
  }

  function registerProactive(pluginCtx, options) {
    pluginCtx.on('agent/created', (payload) => {
      attachAgent(payload?.agent);
    });
    pluginCtx.on('agent/disposed', (payload) => {
      const agent = payload?.agent;
      const dispose = perAgent.get(agent);
      if (dispose !== undefined) {
        perAgent.delete(agent);
        try {
          dispose();
        } catch {
          // Agent context already unwound.
        }
      }
      hints.delete(agent);
    });
    pluginCtx.on('agent/inbox/inserted', (payload) => {
      attachAgent(payload?.agent);
      maybeSuggest(payload?.agent, payload?.message);
    });

    const agents = pluginCtx.get?.('agents');
    if (agents !== undefined && agents !== null && typeof agents.list === 'function') {
      for (const agent of agents.list()) attachAgent(agent);
    }

    function attachAgent(agent) {
      if (agent === undefined || agent === null || perAgent.has(agent)) return;
      const agentCtx = agent.ctx;
      if (agentCtx === undefined || agentCtx === null) return;
      const systemPrompt = agentCtx.systemPrompt ?? agentCtx.get?.('systemPrompt');
      if (systemPrompt === undefined || systemPrompt === null || typeof systemPrompt.context !== 'function') return;
      try {
        const dispose = systemPrompt.context({
          name: 'plugin-advisor-hint',
          order: 900,
          text: () => {
            if (!active) return '';
            if (!isProactive(agent)) return '';
            const hint = hints.get(agent);
            return hint === undefined ? '' : hint.text;
          },
        });
        perAgent.set(agent, dispose);
      } catch (error) {
        pluginCtx.logger?.warn?.(`plugin-advisor: hint context registration failed: ${errorMessage(error)}`);
      }
    }

    function maybeSuggest(agent, message) {
      if (!active || agent === undefined || agent === null) return;
      // A new user instruction ends whatever the previous turn was shown.
      hints.delete(agent);
      if (!isProactive(agent)) return;
      const entries = peekCatalog();
      if (entries === null) return;
      const text = messageText(message);
      if (!shouldHint(text)) return;
      const key = String(agent.id);
      const remaining = cooldown.get(key) ?? 0;
      if (remaining > 0) {
        cooldown.set(key, remaining - 1);
        return;
      }
      try {
        const query = hintQuery(text);
        if (query === '') return;
        const { results } = searchEntries(entries, [query], { limit: 3, excludeDeprecated: true });
        if (results.length === 0) return;
        const previous = lastHintNames.get(key) ?? [];
        const fresh = results.filter((result) => !previous.includes(result.entry.name));
        const hint = buildHint(fresh, 3);
        if (hint === '') return;
        const names = hintNames(fresh, 3);
        hints.set(agent, { text: hint, names, at: Date.now() });
        lastHintNames.set(key, names);
        cooldown.set(key, 3);
      } catch (error) {
        pluginCtx.logger?.warn?.(`plugin-advisor: proactive search failed: ${errorMessage(error)}`);
      }
    }
  }

  function isProactive(agent) {
    if (agent === undefined || agent === null) return settings.proactive;
    const key = String(agent.id);
    if (sessionOverrides.has(key)) return sessionOverrides.get(key);
    return settings.proactive;
  }
}

function normalizeSettings(config) {
  const source = config && typeof config === 'object' ? config : {};
  return {
    proactive: source.proactive === true,
    catalogSource: resolveCatalogSource(source),
    githubToken: typeof source.githubToken === 'string' && source.githubToken !== ''
      ? source.githubToken
      : process.env.PLUGIN_ADVISOR_GITHUB_TOKEN || '',
    readmeChars: clamp(source.readmeChars, 400, 4000, 1200),
    profile: typeof source.profile === 'string' && source.profile !== ''
      ? source.profile
      : detectProfile() || undefined,
  };
}

function normalizeQueries(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return list
    .map((query) => String(query ?? '').trim())
    .filter(Boolean)
    .slice(0, 5);
}

function findEntry(entries, query) {
  const key = String(query ?? '').trim().toLowerCase();
  if (key === '') return null;
  const exact = entries.find((entry) => (
    entry.name.toLowerCase() === key
    || (entry.npm !== null && entry.npm.toLowerCase() === key)
    || entry.url.toLowerCase() === key
  ));
  if (exact !== undefined) return exact;
  const prefix = entries.filter((entry) => (
    entry.name.toLowerCase().startsWith(key)
    || (entry.npm !== null && entry.npm.toLowerCase().startsWith(key))
  ));
  return prefix.length === 1 ? prefix[0] : null;
}

function notFoundMessage(entries, query) {
  const key = String(query ?? '').trim();
  const suggestions = entries
    .filter((entry) => entry.name.toLowerCase().includes(key.toLowerCase()) && key !== '')
    .slice(0, 3)
    .map((entry) => entry.name);
  const suffix = suggestions.length > 0 ? `相近条目：${suggestions.join('、')}。` : '';
  return `目录里没有名为「${key}」的条目。先用 plugin_search 找到准确名称。${suffix}`;
}

function factsOf(catalog) {
  return {
    count: catalog.count,
    updated: catalog.updated,
    source: catalog.source,
  };
}

function readmeCharsOf(value, settings) {
  return clamp(value, 400, 4000, settings.readmeChars);
}

function clamp(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(number)));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** The profile this copy is linked into, when the environment does not say. */
function detectProfile() {
  const direct = process.env.DSH_PROFILE;
  if (typeof direct === 'string' && direct !== '') return direct;
  const home = process.env.DSH_HOME;
  if (typeof home !== 'string' || home === '') return null;
  const root = realpathOrSelf(fileURLToPath(new URL('.', import.meta.url)));
  const profiles = path.join(home, 'profiles');
  const candidates = [['@local', 'plugin-advisor'], ['plugin-advisor']];
  try {
    for (const profileName of readdirSync(profiles)) {
      for (const parts of candidates) {
        const link = path.join(profiles, profileName, 'node_modules', ...parts);
        try {
          if (!existsSync(link)) continue;
          if (realpathOrSelf(link) === root) return profileName;
        } catch {
          // Try the next candidate.
        }
      }
    }
  } catch {
    // No profiles directory in this environment.
  }
  return null;
}

function realpathOrSelf(value) {
  try {
    return realpathSync(value);
  } catch {
    return value;
  }
}
