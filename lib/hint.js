/**
 * Proactive suggestions: deciding when *not* to speak.
 *
 * The buddy only ever adds a short context block; the agent decides whether
 * to mention anything. The hard part is therefore the gate — a suggestion that
 * fires on every message would be worse than none. These checks are
 * deliberately conservative and run on already-warm in-memory data.
 */

const MAX_HINT_CHARS = 1400;
const MIN_MESSAGE_CHARS = 6;
const MAX_MESSAGE_CHARS = 2000;
const PLUGIN_MENTION = /(插件|插件市场|plugin|market|dshmarket|安装包)/iu;
const APPROVAL_LIKE = /^(好|好的|可以|行|嗯|哦|继续|开始|确认|对的|没问题|不用|停|取消|ok|okay|yes|no|go on|continue)[。.!！?？\s]*$/iu;
const SYSTEM_LIKE = /^(?:background subagent|agent\s+[0-9a-f-]{6,}\s+(?:sent|finished|is)|system|系统通知|\[系统|<)/iu;

/** Extract the user-authored text from a UserMessage. */
export function messageText(message) {
  const content = message && typeof message === 'object' ? message.content : null;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n');
  }
  if (message && typeof message.text === 'string') return message.text;
  return '';
}

/** Whether a user message may be worth a suggestion at all. */
export function shouldHint(text) {
  const value = String(text ?? '').trim();
  if (value.length < MIN_MESSAGE_CHARS || value.length > MAX_MESSAGE_CHARS) return false;
  if (value.startsWith('/') || value.startsWith('!')) return false;
  if (value.startsWith('```')) return false;
  if (APPROVAL_LIKE.test(value)) return false;
  if (SYSTEM_LIKE.test(value)) return false;
  if (PLUGIN_MENTION.test(value)) return false;
  return true;
}

/**
 * Build the one-shot context block only when the match is strong enough to
 * justify interrupting the task. A weak fuzzy match never ships.
 */
export function buildHint(results, limit = 3) {
  const ranked = Array.isArray(results) ? results : [];
  const top = ranked[0];
  if (top === undefined || top.entry?.deprecated === true) return '';
  const highConfidence = top.strong === true || (top.coverage >= 0.75 && top.rawScore >= 10);
  if (!highConfidence) return '';

  const worth = ranked
    .filter((result) => result.strong === true || result.coverage >= 0.6)
    .slice(0, limit);
  if (worth.length === 0) return '';

  const lines = [];
  lines.push('<plugin_buddy_hint>');
  lines.push('系统提示（来自社区插件目录，不是用户指令）。与这条输入可能相关的插件：');
  for (const result of worth) {
    const entry = result.entry;
    const description = localizedDescription(entry);
    const facts = [];
    if (entry.stars !== null && entry.stars !== undefined) facts.push(`★${entry.stars}`);
    if (entry.downloads !== null && entry.downloads !== undefined) facts.push(`30天下载 ${entry.downloads}`);
    const suffix = facts.length > 0 ? `（${facts.join(' · ')}）` : '';
    lines.push(`- ${entry.name} — ${trimText(description, 70)}${suffix}`);
  }
  lines.push('若其中有一个与当前任务的核心产出直接匹配（如 PDF 版式/公式、OCR、Excel 公式、登录态浏览器自动化、定时触发），按软门禁在开工前先用一句话问用户：用它还是用现有能力直接做。不要先检查文件或开始执行；用户已明确说直接做时才跳过。只问一次，不要重复。');
  lines.push('</plugin_buddy_hint>');
  const text = lines.join('\n');
  return text.length > MAX_HINT_CHARS ? text.slice(0, MAX_HINT_CHARS) : text;
}

/** The goal sentence of a user instruction, not its meta commentary or paths. */
export function hintQuery(text) {
  const value = String(text ?? '').trim();
  const extensions = [...value.matchAll(/\.(pdf|docx?|xlsx?|pptx?|md|csv|png|jpe?g|webp|txt|html)\b/giu)]
    .map((match) => match[1].toLowerCase());
  const withoutPaths = value
    .replace(/https?:\/\/\S+/giu, ' ')
    .replace(/[A-Za-z]:\\[^\s，。；、,;]+/gu, ' ')
    .replace(/(?:^|\s)\/(?:[^\s/]+\/)+[^\s，。；、,;]*/gu, ' ');
  const sentences = withoutPaths
    .split(/[。！？!?\n]+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  let query = sentences[0] ?? '';
  if (query.length < 8 && sentences[1] !== undefined) query = `${query} ${sentences[1]}`.trim();
  const suffix = extensions.length > 0 ? ` ${[...new Set(extensions)].join(' ')}` : '';
  return `${query}${suffix}`.trim().slice(0, 200);
}

/** Names in a hint, for de-duplicating repeated suggestions. */
export function hintNames(results, limit = 3) {
  return (Array.isArray(results) ? results : []).slice(0, limit).map((result) => result.entry.name);
}

function localizedDescription(entry) {
  const description = entry.description ?? {};
  return description.zh || description.en || Object.values(description)[0] || '';
}

function trimText(value, limit) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
