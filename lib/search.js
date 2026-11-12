/**
 * Intent search over the community catalog.
 *
 * The market's own search is a token-containment match on one field at a time.
 * This module keeps the cheap, deterministic part (no embeddings, no network)
 * but adds what makes a vague request findable: script-aware normalization,
 * spoken-Chinese stop words, bilingual alias expansion, partial coverage,
 * multi-query fusion, and a quality only as a tie-breaker.
 */

const BOUNDARY = /(?:\p{Script=Han}(?=[\p{Script=Latin}\p{N}])|[\p{Script=Latin}\p{N}](?=\p{Script=Han}))/gu;
const STOP_PHRASES = /(?:可以|怎么|如何|什么|请问|帮我|帮忙|一个|一下|插件|工具|推荐|有没有|适合|支持|需要|使用|用来|能够)/gu;
const STOP_CHARS = /[的把被了着过能会想要给我你他她它这那哪个些吗呢吧呀啊哦嗯和与或及在是有就都也还很更最请]/gu;
const CJK_RUN = /^[\p{Script=Han}]+$/u;

const ALIAS_GROUPS = [
  ['pdf', '文档', 'document', 'doc', '转换', 'convert', '格式转换'],
  ['ocr', '识别', '图片', '图像', '截图', 'image', 'vision', '视觉', '文字识别', '提取文字'],
  ['excel', 'xlsx', '表格', 'spreadsheet', 'csv', '工作表'],
  ['word', 'docx', '文档处理'],
  ['ppt', 'pptx', '幻灯片', 'presentation', 'slides'],
  ['markdown', 'md', 'markdown转换'],
  ['search', '搜索', '检索', '联网', 'websearch'],
  ['browser', '浏览器', '网页', 'web', 'playwright', 'puppeteer'],
  ['memory', '记忆', '长期记忆', 'knowledge', '知识库', 'rag', 'embedding'],
  ['theme', '主题', '皮肤', 'skin', '外观'],
  ['terminal', '终端', 'shell', '命令行', 'bash', 'pwsh'],
  ['git', 'github', 'gitlab', '版本控制'],
  ['docker', '容器', 'container'],
  ['mcp', 'model context protocol'],
  ['tts', '语音', 'speech', '朗读', '配音'],
  ['asr', '语音识别', '转写', 'transcribe'],
  ['translate', '翻译', 'translation'],
  ['schedule', '定时', '计划任务', 'cron', 'reminder', '提醒'],
  ['email', '邮件', 'mail', 'smtp'],
  ['database', '数据库', 'sql', 'sqlite', 'postgres', 'mysql'],
  ['api', '接口', 'http', 'rest', 'graphql'],
  ['test', '测试', 'testing', '单元测试'],
  ['video', '视频', 'ffmpeg', '剪辑'],
  ['audio', '音频', '音乐', 'music'],
  ['imagegen', '绘图', '画图', '生成图片', '文生图'],
  ['chart', '图表', '可视化', 'visualization', 'plot'],
  ['office', '办公', '文档'],
  ['notion'],
  ['飞书', 'feishu', 'lark'],
  ['微信', 'wechat'],
  ['钉钉', 'dingtalk'],
  ['slack'],
  ['discord'],
  ['telegram'],
  ['backup', '备份', '同步', 'sync'],
  ['security', '安全', '权限', 'permission', 'sandbox'],
  ['prompt', '提示词', 'prompt engineering'],
  ['agent', '智能体', 'subagent', '子代理'],
  ['skill', '技能'],
  ['workflow', '工作流', '流程'],
  ['file', '文件', '目录', 'folder', 'filesystem'],
  ['compression', '压缩', 'zip', '解压'],
  ['crawler', '爬虫', '爬取', 'scrape'],
  ['screenshot', '截图', 'screen capture'],
  ['notification', '通知', '提醒'],
  ['monitor', '监控', '日志', 'log'],
  ['weather', '天气'],
  ['finance', '股票', '金融', 'stock'],
  ['code', '代码', '编程', 'review', '重构'],
  ['subtitle', '字幕', 'caption'],
  ['music', '音乐', '歌'],
  ['math', '公式', 'latex', 'formula'],
];

const ALIASES = new Map();
for (const group of ALIAS_GROUPS) {
  const terms = group.map(normalize).filter(Boolean);
  for (const term of terms) {
    let entry = ALIASES.get(term);
    if (!entry) {
      entry = new Set();
      ALIASES.set(term, entry);
    }
    for (const other of terms) entry.add(other);
  }
}

const FIELD_WEIGHTS = { name: 8, npm: 8, owner: 3, description: 4, category: 2 };
const fieldCache = new WeakMap();

/** Normalize a name, description, or query for comparison. */
export function normalize(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(BOUNDARY, '$& ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Normalized text with spoken-Chinese filler removed. */
export function cleanQuery(value) {
  return normalize(value)
    .replace(STOP_PHRASES, ' ')
    .replace(STOP_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Turn cleaned text into term groups: one group per source word, with CJK
 * shingles for runs longer than two characters. Coverage is counted per
 * group, so a shingle cannot inflate a match that the source word never made.
 */
export function extractTermGroups(text, maxGroups = 10) {
  const pieces = String(text ?? '').split(' ').filter(Boolean).slice(0, maxGroups);
  const groups = [];
  for (const piece of pieces) {
    const group = [];
    if (CJK_RUN.test(piece)) {
      if (piece.length === 1) continue;
      group.push(piece);
      if (piece.length > 2) {
        for (let index = 0; index + 2 <= piece.length; index += 1) {
          group.push(piece.slice(index, index + 2));
        }
      }
    } else if (piece.length >= 2 || /[a-z0-9]/i.test(piece)) {
      group.push(piece);
    }
    if (group.length > 0) groups.push([...new Set(group)]);
  }
  return groups;
}

/** Search the projected catalog entries. Pure; callers own caching. */
export function searchEntries(entries, queries, options = {}) {
  const limit = clamp(options.limit ?? 6, 1, 12);
  const category = options.category ? normalize(options.category) : '';
  const capability = options.capability ? String(options.capability).trim().toLowerCase() : '';
  const excludeDeprecated = options.excludeDeprecated !== false;
  const queryList = (Array.isArray(queries) ? queries : [queries])
    .map((query) => String(query ?? '').trim())
    .filter(Boolean)
    .slice(0, 5);

  const ranked = [];
  for (const query of queryList) {
    const cleaned = cleanQuery(query);
    const groups = extractTermGroups(cleaned, 10);
    if (groups.length === 0) continue;
    const hits = [];
    for (const entry of entries) {
      if (excludeDeprecated && entry.deprecated) continue;
      if (category !== '' && !entry.categories.some((item) => normalize(item).includes(category))) continue;
      if (capability !== '' && !(entry.capabilities ?? []).some((item) => item.toLowerCase() === capability)) continue;
      const scored = scoreEntry(entry, groups);
      if (scored === null) continue;
      hits.push({ entry, ...scored });
    }
    hits.sort((left, right) => (right.score + quality(right.entry)) - (left.score + quality(left.entry)));
    const window = Math.min(hits.length, 40);
    for (let index = 0; index < window; index += 1) {
      ranked.push({ ...hits[index], query, rank: index + 1 });
    }
  }

  const fused = new Map();
  for (const hit of ranked) {
    const key = hit.entry.name;
    let row = fused.get(key);
    if (!row) {
      row = {
        entry: hit.entry,
        rrf: 0,
        rawScore: 0,
        coverage: 0,
        strong: false,
        matched: new Set(),
        queries: new Set(),
      };
      fused.set(key, row);
    }
    row.rrf += 1 / (60 + hit.rank);
    row.rawScore = Math.max(row.rawScore, hit.score);
    row.coverage = Math.max(row.coverage, hit.coverage);
    row.strong = row.strong || hit.strong;
    for (const term of hit.matchedTerms) row.matched.add(term);
    row.queries.add(hit.query);
  }

  const results = [...fused.values()]
    .map((row) => ({
      entry: row.entry,
      rrf: row.rrf,
      rawScore: row.rawScore,
      coverage: row.coverage,
      strong: row.strong,
      matched: [...row.matched].slice(0, 6),
      queries: [...row.queries],
    }))
    .sort((left, right) => (right.rrf - left.rrf) || (quality(right.entry) - quality(left.entry)));

  return { results: results.slice(0, limit), matchedCount: results.length, queries: queryList };
}

function scoreEntry(entry, groups) {
  const fields = fieldsOf(entry);
  let score = 0;
  let matched = 0;
  let strong = false;
  const matchedTerms = [];

  for (const group of groups) {
    let best = 0;
    let bestTerm = null;
    let strongHit = false;
    for (const term of group) {
      const specificity = term.length >= 3 ? 1 : ALIASES.has(term) ? 0.8 : 0.3;
      const wholeWord = term === group[0] ? 1.5 : 1;
      for (const alternative of expand(term)) {
        const weight = (alternative === term ? 1 : 0.5) * specificity * wholeWord;
        let hit = 0;
        if (fields.name.includes(alternative) || fields.npm.includes(alternative)) {
          hit = Math.max(hit, FIELD_WEIGHTS.name * weight);
          if (alternative === term) strongHit = true;
        }
        if (fields.owner.includes(alternative)) {
          hit = Math.max(hit, FIELD_WEIGHTS.owner * weight);
        }
        for (const description of fields.descriptions) {
          if (description.includes(alternative)) {
            hit = Math.max(hit, FIELD_WEIGHTS.description * weight);
          }
        }
        for (const category of fields.categories) {
          if (category.includes(alternative)) {
            hit = Math.max(hit, FIELD_WEIGHTS.category * weight);
            if (alternative === term) strongHit = true;
          }
        }
        if (hit > best) {
          best = hit;
          bestTerm = term;
        }
      }
    }
    if (best > 0) {
      matched += 1;
      score += best;
      if (bestTerm !== null && isDisplayTerm(bestTerm)) matchedTerms.push(bestTerm);
      strong = strong || strongHit;
    }
  }

  if (matched === 0) return null;
  const coverage = matched / groups.length;
  if (coverage < 0.34 && !strong) return null;

  const phrase = groups.map((group) => group[0]).join(' ');
  if (fields.name.includes(phrase) || fields.descriptions.some((text) => text.includes(phrase))) {
    score += 4;
  }
  return { score: score * (0.5 + coverage), coverage, strong, matchedTerms };
}

function fieldsOf(entry) {
  let fields = fieldCache.get(entry);
  if (fields !== undefined) return fields;
  fields = {
    name: normalize(entry.name),
    npm: normalize(entry.npm ?? ''),
    owner: normalize(entry.owner ?? ''),
    descriptions: Object.values(entry.description ?? {}).map(normalize).filter(Boolean),
    categories: (entry.categories ?? []).map(normalize),
  };
  fieldCache.set(entry, fields);
  return fields;
}

function expand(term) {
  const aliases = ALIASES.get(term);
  return aliases === undefined ? [term] : [term, ...aliases].filter((item, index, list) => list.indexOf(item) === index);
}

/** Keep the "why it matched" line readable: no CJK shingles unless they are aliases. */
function isDisplayTerm(term) {
  if (ALIASES.has(term)) return true;
  if (/^[a-z0-9]{2,}$/iu.test(term)) return true;
  return term.length >= 3;
}

/** Popularity is context, never a verdict; it only breaks relevance ties. */
export function quality(entry) {
  const downloads = Math.log1p(entry.downloads ?? 0);
  const stars = 0.8 * Math.log1p(entry.stars ?? 0);
  const addedAt = entry.added ? Date.parse(entry.added) : Number.NaN;
  const ageDays = Number.isNaN(addedAt) ? 365 : (Date.now() - addedAt) / 86_400_000;
  const fresh = ageDays >= 0 && ageDays <= 30 ? 0.5 : 0;
  return downloads + stars + fresh - (entry.deprecated ? 2 : 0);
}

function clamp(value, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.trunc(number)));
}
