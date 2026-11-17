/**
 * Turn fetched documentation into a grounded onboarding draft.
 *
 * Every field is extracted from the README or the package manifest. A field
 * with no source stays empty and is reported in `gaps` — the buddy must be
 * able to say "the README does not say", which is a fact the model can use.
 */

export function buildGuide(entry, docs, options = {}) {
  const doc = docs.doc;
  const profile = typeof options.profile === 'string' && options.profile !== ''
    ? options.profile
    : process.env.DSH_PROFILE || '';
  const installSpec = specOf(entry);
  const installCommand = profile === ''
    ? `在「插件」页添加 ${installSpec}（或运行 dsh plugin --profile <你的 profile> add ${installSpec}）`
    : `dsh plugin --profile ${profile} add ${installSpec}`;
  const uninstallCommand = profile === ''
    ? `在「插件」页移除 ${installSpec}（或运行 dsh plugin --profile <你的 profile> remove ${installSpec}）`
    : `dsh plugin --profile ${profile} remove ${installSpec}`;

  const gaps = [];
  const whatItDoes = doc.summary || localizedDescription(entry) || '（README 未提供摘要）';

  const prerequisites = unique([
    ...bullets(doc.classified.requirements, 6),
    ...scanPrerequisites([doc.classified.requirements, doc.classified.install].filter(Boolean).join('\n'), 4),
  ]).slice(0, 6);

  const setup = [installCommand];
  const installBullets = bullets(doc.classified.install, 2);
  setup.push(...installBullets);
  const usageBullets = bullets(doc.classified.usage, 3);
  for (const item of usageBullets) {
    if (setup.length >= 5) break;
    setup.push(item);
  }
  if (setup.length === 0) gaps.push('安装/上手步骤（README 未给出）');

  const config = unique([
    ...bullets(doc.classified.config, 5),
    ...scanEnv(doc.classified.config, 3),
  ]).slice(0, 6);
  if (config.length === 0 && doc.classified.config === '') {
    // Not a gap: most plugins legitimately need no configuration.
  }

  const examples = pickExamples(doc, 3);
  if (examples.length === 0 && usageBullets.length === 0) gaps.push('使用示例（README 的使用章节没有代码块或示例）');
  if (doc.classified.usage === '') gaps.push('使用说明章节（README 未提供）');
  if (doc.classified.install === '') gaps.push('安装章节（README 未提供）');

  const verify = scanVerify([doc.classified.usage, doc.classified.install].filter(Boolean).join('\n')).slice(0, 4);
  if (verify.length === 0) {
    verify.push('安装后在对话里让 Agent 用它做一个小任务，确认工具或界面出现。');
  }

  const troubleshooting = [];
  const troubleshootBody = firstLines(doc.classified.troubleshoot, 800);
  if (troubleshootBody !== '') troubleshooting.push(troubleshootBody);
  if (docs.repoFacts !== null && docs.repoFacts !== undefined) {
    troubleshooting.push(`问题反馈：${docs.repoFacts.htmlUrl}/issues`);
  }

  const notes = [];
  if (Array.isArray(entry.capabilities) && entry.capabilities.length > 0) {
    notes.push(`能力披露：${entry.capabilities.join('、')}`);
  }
  if (Array.isArray(entry.capabilityRedLines) && entry.capabilityRedLines.length > 0) {
    notes.push(...entry.capabilityRedLines.slice(0, 3));
  }
  if (entry.deprecated) {
    notes.push(`该插件已弃用${entry.replacement ? `，建议改用 ${entry.replacement}` : ''}。`);
  }

  return {
    entry,
    whatItDoes,
    prerequisites,
    setup,
    config,
    examples,
    verify,
    troubleshooting,
    uninstall: uninstallCommand,
    notes,
    gaps,
    sources: docs.sources,
    readmeSource: docs.readmeSource,
    fetchedAt: docs.fetchedAt,
  };
}

export function localizedDescription(entry) {
  const description = entry.description ?? {};
  return description.zh || description.en || Object.values(description)[0] || '';
}

/** Short usage examples: code blocks that are not install commands. */
export function pickExamples(doc, limit = 3) {
  return codeBlocksIn(doc.classified.usage, limit)
    .filter((block) => !/^(dsh|pnpm|npm|yarn|bun)\s+(plugin|add|install|i)\b/iu.test(block.code.trim()))
    .map((block) => ({ language: block.language, code: block.code.slice(0, 600) }));
}

function specOf(entry) {
  const install = typeof entry.install === 'string' ? entry.install.trim() : '';
  const marker = install.indexOf(' add ');
  if (marker !== -1) return install.slice(marker + 5).trim();
  return install || entry.npm || entry.url || entry.name;
}

function bullets(text, limit) {
  const items = [];
  let current = null;
  const flush = () => {
    if (current === null) return;
    const value = cleanLine(current);
    if (value !== '') items.push(value.slice(0, 300));
    current = null;
  };
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    const match = /^([-*+]|\d+\.)\s+(.+)$/u.exec(line);
    if (match !== null) {
      flush();
      current = match[2];
      continue;
    }
    if (current === null) continue;
    if (line === '' || /^#{1,6}\s/u.test(line) || line.startsWith('```')) {
      flush();
    } else {
      current += ` ${line}`;
    }
  }
  flush();
  return items.slice(0, limit);
}

function codeBlocksIn(text, limit) {
  const blocks = [];
  const pattern = /```([^\n]*)\n([\s\S]*?)```/gu;
  let match = pattern.exec(String(text ?? ''));
  while (match !== null && blocks.length < limit) {
    blocks.push({ language: match[1].trim().split(/\s+/u)[0] ?? '', code: match[2].trim().slice(0, 600) });
    match = pattern.exec(String(text ?? ''));
  }
  return blocks;
}

function scanPrerequisites(text, limit) {
  return unique([...bullets(text, 40), ...sentenceLines(text)])
    .filter((line) => /(需要|requires?|prerequisite|前置|api[_ -]?key|token|密钥|node(?:\.js)?\s*\d|pnpm|依赖)/iu.test(line))
    .filter((line) => line.length > 8 && line.length < 300)
    .slice(0, limit);
}

function scanEnv(text, limit) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[A-Z][A-Z0-9_]{2,}\s*=/u.test(line))
    .slice(0, limit);
}

function scanVerify(text) {
  return unique([...bullets(text, 40), ...sentenceLines(text)])
    .filter((line) => /(验证|verify|check|确认|试一下|test it|应该看到|should see)/iu.test(line))
    .filter((line) => line.length > 8 && line.length < 300)
    .slice(0, 4);
}

function sentenceLines(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== ''
      && !/^([-*+]|\d+\.)\s+/u.test(line)
      && !/^#{1,6}\s/u.test(line)
      && !line.startsWith('```'))
    .filter((line) => /[。.!！?？:]$/u.test(line))
    .map(cleanLine)
    .filter(Boolean);
}

function cleanLine(value) {
  return String(value)
    .replace(/^([-*+]|\d+\.)\s+/u, '')
    .replace(/\*\*/gu, '')
    .replace(/`([^`]+)`/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/\s+/gu, ' ')
    .trim();
}

function firstLines(text, limit) {
  const value = String(text ?? '').trim();
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function unique(list) {
  return [...new Set(list)];
}
