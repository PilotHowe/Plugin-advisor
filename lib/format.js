/**
 * Model-facing text for the plugin buddy tools.
 *
 * Results are bounded on purpose: a shortlist plus a way to ask for more, not
 * a dump of the catalog. Every truncation is stated so the model cannot read a
 * shortened answer as a complete one.
 */

import { localizedDescription } from './guide.js';

const DESCRIPTION_LIMIT = 110;

export function formatSearch({ facts, results, matchedCount, queries, stale }) {
  const lines = [];
  const header = facts === null
    ? '插件目录：未知（尚未读取）'
    : `插件目录：${formatNumber(facts.count)} 条 · 更新 ${facts.updated ?? '未知'} · 来源 ${facts.source}`;
  lines.push(header);
  if (stale === true) {
    lines.push('注意：这是上次成功读取的缓存，可能不是最新目录。');
  }
  if (Array.isArray(queries) && queries.length > 0) {
    lines.push(`查询：${queries.join(' | ')}`);
  }
  lines.push('');

  if (results.length === 0) {
    lines.push('没有命中。建议：换更短的中英文关键词；减少 category/capability 过滤；把整句拆成 2–4 个关键词。');
    return lines.join('\n');
  }

  results.forEach((result, index) => {
    const entry = result.entry;
    lines.push(`${index + 1}) ${entry.name}${entry.npm ? `（${entry.npm}）` : ''} — ${truncate(localizedDescription(entry), DESCRIPTION_LIMIT)}`);
    const factsLine = [
      entry.owner || null,
      entry.categories.length > 0 ? `分类：${entry.categories.join('/')}` : null,
      entry.stars === null ? null : `★${formatNumber(entry.stars)}`,
      entry.downloads === null ? null : `30天下载 ${formatNumber(entry.downloads)}`,
      entry.added === null ? null : `收录 ${entry.added}`,
      entry.version === null ? null : `v${entry.version}`,
    ].filter(Boolean);
    if (factsLine.length > 0) lines.push(`   ${factsLine.join(' · ')}`);
    if (Array.isArray(entry.capabilities) && entry.capabilities.length > 0) {
      lines.push(`   能力：${entry.capabilities.join('、')}`);
    }
    if (entry.deprecated) {
      lines.push(`   已弃用${entry.replacement ? ` → ${entry.replacement}` : ''}`);
    }
    lines.push(`   安装 spec：${installSpecOf(entry)}`);
    if (result.matched.length > 0) {
      lines.push(`   命中：${result.matched.join('、')}`);
    }
    lines.push('');
  });

  lines.push(`返回 ${results.length} / 命中 ${matchedCount} 条。需要细节用 plugin_inspect，需要上手步骤用 plugin_guide。`);
  if (matchedCount > results.length) {
    lines.push(`另有 ${matchedCount - results.length} 条未显示；提高 limit（最多 12）或缩小查询。`);
  }
  return lines.join('\n');
}

export function formatInspect(docs, options = {}) {
  const entry = docs.entry;
  const lines = [];
  lines.push(`${entry.name}${entry.npm ? `（${entry.npm}）` : ''}${entry.owner ? ` · ${entry.owner}` : ''}`);
  if (entry.url) lines.push(`仓库：${entry.url}`);
  lines.push(`安装 spec：${installSpecOf(entry)}`);
  const facts = [
    entry.version === null ? null : `版本 ${entry.version}`,
    entry.added === null ? null : `收录 ${entry.added}`,
    entry.stars === null ? null : `★${formatNumber(entry.stars)}`,
    entry.downloads === null ? null : `30天下载 ${formatNumber(entry.downloads)}`,
    entry.enginesDsh === null ? null : `宿主声明 ${entry.enginesDsh}`,
  ].filter(Boolean);
  if (facts.length > 0) lines.push(facts.join(' · '));
  if (Array.isArray(entry.capabilities) && entry.capabilities.length > 0) {
    lines.push(`能力披露：${entry.capabilities.join('、')}`);
  }
  if (Array.isArray(entry.capabilityRedLines) && entry.capabilityRedLines.length > 0) {
    lines.push(`能力红线：${entry.capabilityRedLines.join('；')}`);
  }
  if (entry.deprecated) {
    lines.push(`弃用：是${entry.replacement ? `，替代 ${entry.replacement}` : ''}`);
  }

  if (docs.repoFacts !== null && docs.repoFacts !== undefined) {
    const repoFacts = docs.repoFacts;
    lines.push(`许可证：${repoFacts.license ?? '未知'} · 默认分支 ${repoFacts.defaultBranch ?? '未知'} · 最近推送 ${repoFacts.pushedAt ?? '未知'}${repoFacts.archived ? ' · 已归档' : ''}${repoFacts.fork ? ' · 是 fork' : ''}`);
  }

  const docFacts = docs.doc;
  lines.push(`文档：README ${docFacts.hasReadme ? `${formatNumber(docFacts.length)} 字符` : '未读取到'} · 安装 ${docFacts.classified.install !== '' ? '✓' : '—'} · 使用 ${docFacts.classified.usage !== '' ? '✓' : '—'} · 示例 ${docFacts.codeBlocks.length > 0 ? '✓' : '—'}`);
  if (docFacts.summary) lines.push(`摘要：${docFacts.summary}`);

  if (typeof options.readmeChars === 'number' && options.readmeChars > 0 && typeof docs.readme === 'string' && docs.readme.trim() !== '') {
    lines.push('README 摘录：');
    lines.push(cleanExcerpt(docs.readme, options.readmeChars));
  }

  if (docFacts.headings.length > 0) {
    lines.push(`章节：${docFacts.headings.slice(0, 12).join(' / ')}`);
  }

  if (docFacts.codeBlocks.length > 0) {
    lines.push('关键代码块：');
    for (const block of docFacts.codeBlocks.slice(0, 3)) {
      lines.push(`\`\`\`${block.language}\n${truncate(block.code, 500)}\n\`\`\``);
    }
  }

  if (docs.npm !== null && docs.npm !== undefined) {
    const dsh = docs.npm.dsh;
    const manifestFacts = [];
    if (docs.npm.license) manifestFacts.push(`许可证 ${docs.npm.license}`);
    if (dsh && typeof dsh === 'object' && dsh.bundle && typeof dsh.bundle === 'object' && typeof dsh.bundle.patch === 'string') {
      manifestFacts.push(`patch ${dsh.bundle.patch}`);
    }
    if (dsh && typeof dsh === 'object' && dsh.client !== undefined) manifestFacts.push('含客户端半');
    if (docs.npm.engines && typeof docs.npm.engines.dsh === 'string') manifestFacts.push(`engines.dsh ${docs.npm.engines.dsh}`);
    if (manifestFacts.length > 0) lines.push(`包清单：${manifestFacts.join(' · ')}`);
  }

  if (docs.errors.length > 0) {
    lines.push(`抓取提示：${docs.errors.join('；')}`);
  }
  lines.push(`文档来源：${docs.sources.length > 0 ? docs.sources.join('、') : '无（只返回目录元数据）'}${docs.readmeSource !== 'none' ? `（README 来自 ${docs.readmeSource}）` : ''}`);
  if (docs.readme !== null && options.readmeChars !== undefined && docs.readme.length > options.readmeChars) {
    lines.push(`README 已截断：显示 ${formatNumber(options.readmeChars)} / ${formatNumber(docs.readme.length)} 字符。`);
  }
  lines.push('需要可执行的上手步骤用 plugin_guide。');
  return lines.join('\n');
}

export function formatGuide(guide) {
  const entry = guide.entry;
  const lines = [];
  lines.push(`上手卡：${entry.name}${entry.npm ? `（${entry.npm}）` : ''}`);
  lines.push('');
  lines.push(`能做什么：${guide.whatItDoes}`);

  if (guide.prerequisites.length > 0) {
    lines.push('装前准备：');
    for (const item of guide.prerequisites) lines.push(`- ${item}`);
  }
  if (guide.setup.length > 0) {
    lines.push('上手步骤：');
    let step = 0;
    for (const item of guide.setup) {
      if (item.startsWith('```')) {
        lines.push(item);
      } else {
        step += 1;
        lines.push(`${step}. ${item}`);
      }
    }
  }
  if (guide.config.length > 0) {
    lines.push('配置：');
    for (const item of guide.config) lines.push(`- ${item}`);
  }
  if (guide.examples.length > 0) {
    lines.push('试试这样用：');
    for (const example of guide.examples) {
      lines.push(example.language === '' ? `- ${example.code}` : `\`\`\`${example.language}\n${example.code}\n\`\`\``);
    }
  }
  if (guide.verify.length > 0) {
    lines.push('怎么验证：');
    for (const item of guide.verify) lines.push(`- ${item}`);
  }
  if (guide.troubleshooting.length > 0) {
    lines.push('排错：');
    for (const item of guide.troubleshooting) lines.push(`- ${item}`);
  }
  lines.push(`卸载：${guide.uninstall}`);
  if (guide.notes.length > 0) {
    lines.push('注意：');
    for (const item of guide.notes) lines.push(`- ${item}`);
  }
  if (guide.gaps.length > 0) {
    lines.push(`README 未说明：${guide.gaps.join('、')}（不要替作者补全，先向用户说明缺失）`);
  }
  lines.push(`来源：${guide.sources.length > 0 ? guide.sources.join('、') : '目录元数据'}${guide.readmeSource !== 'none' ? `（README 来自 ${guide.readmeSource}）` : ''}`);
  return lines.join('\n');
}

export function installSpecOf(entry) {
  const install = typeof entry.install === 'string' ? entry.install.trim() : '';
  const marker = install.indexOf(' add ');
  if (marker !== -1) return install.slice(marker + 5).trim();
  return install || entry.npm || entry.url || entry.name;
}

function formatNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('zh-CN').format(value);
}

function truncate(value, limit) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** Shrink a README for the model without the badge/HTML noise at the top. */
function cleanExcerpt(value, limit) {
  const text = String(value)
    .replace(/<!--[\s\S]*?-->/gu, '')
    .split('\n')
    .filter((line) => {
      if (/^\s*\[!\[/iu.test(line)) return false;
      const plain = line.replace(/<[^>]*>/gu, '').trim();
      return plain !== '' || line.trim() === '';
    })
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
