# 插件顾问（Plugin advisor）

装在 DeepSeek Harness 里的社区插件顾问。**不用手动逛插件市场，也不用先知道插件叫什么**：说出你的任务，它就从 1 万+ 条社区插件目录里推荐可复用的优质插件，判断质量，并给出有据可查的上手步骤。检索的是插件市场目录（npm 包 `dsh-plugin-catalog` 的 `plugins.json`），不是本机已安装列表。

## 安装

- **从 GitHub（无需构建）**：

  ```sh
  dsh plugin --profile <profile> add github:PilotHowe/Plugin-advisor
  ```

  桌面端也可以在「插件 → 添加插件」里填入 `github:PilotHowe/Plugin-advisor`。
- **npm（发布后）**：`dsh plugin --profile <profile> add plugin-advisor`
- 安装后在对话里直接说任务；`/plugin-hint on` / `off` 控制主动提示，`/plugin-hint status` 查看状态。

## 解决什么问题

- **插件太多，找不到前人的成果，也不想自己先知道插件叫什么**：1 万+ 条目录、关键词搜索往往只知道名字里有没有那几个字；很多任务因此从头再来，已经验证过的方案反而闲置。插件顾问按任务拆词、中英别名、多查询融合，并带质量事实地找到「已经有人做好、值得复用/二创」的那一个，同时给出仓库、许可证、`dsh.bundle.patch` 路径。
- **找到了也不会用**：README 面向作者，非专业用户不知道装前要什么、第一步怎么走、怎么验证。插件顾问把 README/包清单整理成有据可查的上手卡（装前准备 / 3 步上手 / 示例 / 验证 / 排错 / 卸载），README 没写的会明确标出，不替作者补全。
- **简单用一下，发挥不出最大价值**：插件的价值在「用对场景 + 配置 + 提示词」。插件顾问在高置信度时先问你是否用插件，并给出可直接粘贴的示例提示词与配置要点，而不是装完就丢。

## 能做什么

- **按目标找插件**：把「我想把 PDF 转成 Markdown 并保留公式」拆成中英关键词，返回候选、质量事实、能力披露、弃用/替代与安装 spec。
- **判断质量**：看维护活跃、文档完整度、许可证、宿主声明、能力红线；★ 和下载量只作参考。
- **给上手步骤**：从 README/包清单提取「装前准备 / 3 步上手 / 配置 / 示例 / 验证 / 排错 / 卸载」，README 没写的明确标出，不替作者补全。
- **看能不能二创**：仓库、许可证、`dsh.bundle.patch` 路径、包清单要点。
- **高置信度主动提示**：默认开启，但只在匹配足够强时触发；触发后走「软门禁」——先问一句是否用插件，而不是直接切换。

## 软门禁

匹配足够强、且任务的核心产出正是插件擅长的（PDF 版式/公式、扫描件 OCR、Excel 公式、需要登录态的浏览器自动化、定时触发等）时，在开工前问一句：

> 这个任务用 `<插件名>` 更合适：<一句原因>。要我帮你装上并用它做，还是先用现有能力直接做？

- 用户说「用插件」→ 展示来源与能力披露后安装，再完成任务。
- 用户说「直接做」→ 立即用内置能力完成，本任务内不再提。
- 普通写代码、改文件、搜索、总结、问答不会触发；弱匹配也不会触发。

## 开关

- 主动提示**默认开启**（配置 `proactive: true`），但只有高置信度才触发。
- 会话级关闭/开启：`/plugin-hint off`、`/plugin-hint on`、`/plugin-hint status`（立即生效，不写文件）。
- 持久默认：在 profile patch 的 `config:` 下改 `proactive`。
- 同一会话每 3 条用户消息最多提示一次；斜杠命令、短回复、系统通知、已经提到插件的消息不会触发。

## 工具

| 工具 | 用途 |
|---|---|
| `plugin_search` | 多组关键词检索目录 |
| `plugin_inspect` | 单插件详情、README 摘录、相似/替代、二创信息 |
| `plugin_guide` | 有据可查的上手卡 |

技能 `plugin-advisor` 会指导 Agent 的检索、判断、推荐、安装与上手格式。

## 配置（均为可选）

| 键 | 默认 | 说明 |
|---|---|---|
| `proactive` | `true` | 高置信度主动提示的持久默认值 |
| `catalogUrl` | 官方目录 | 目录地址；也可用 `PLUGIN_ADVISOR_CATALOG_URL` / `DSHM_REGISTRY_URL` |
| `githubToken` | 空 | 提升 GitHub API 限流；也可用 `PLUGIN_ADVISOR_GITHUB_TOKEN` |
| `readmeChars` | `1200` | `plugin_inspect` 的 README 摘录长度（400–4000） |
| `profile` | `DSH_PROFILE` | 上手卡里安装/卸载命令使用的 profile 名 |

## 数据源

- 目录：npm 包 `dsh-plugin-catalog` 的 `plugins.json`（4 MB tarball，几秒可下载；30 分钟内存缓存；刷新失败时 6 小时内的缓存会标注后返回）。官方 JSON `https://awesome-dsh-plugin.com/plugins.json` 作为兜底，也可用 `catalogUrl` / `PLUGIN_ADVISOR_CATALOG_URL` / `DSHM_REGISTRY_URL` 指向镜像。
- npm 清单与 README：`https://registry.npmjs.org/<pkg>/latest`。
- GitHub README/仓库事实：`https://api.github.com`（未认证 60 次/时）。
- 不使用 `raw.githubusercontent.com` / `cdn.jsdelivr.net`（在目标网络实测不可达）。

## 隐私

- 不收集、不上传任何遥测；查询只在本机内存里检索。
- 不打印 token、本机路径或密钥；GitHub token 只从配置/环境变量读取。
- 插件不执行安装；安装由 Agent 通过 `plugin_manager` 在你确认后进行。

---

# Plugin advisor (English)

A community plugin advisor for DeepSeek Harness. **No manual market browsing, and no need to know a plugin's name first**: describe your task and it recommends reusable, high-quality plugins from a catalog of 10,000+ entries, judges their quality, and gives you grounded onboarding steps. It searches the community plugin catalog (the `plugins.json` in the `dsh-plugin-catalog` npm package), not the locally installed plugins.

## Install

- **From GitHub (no build step)**:

  ```sh
  dsh plugin --profile <profile> add github:PilotHowe/Plugin-advisor
  ```

  On the desktop app, enter `github:PilotHowe/Plugin-advisor` in **Plugins → Add plugin**.
- **npm (once published)**: `dsh plugin --profile <profile> add plugin-advisor`
- After installation, just describe a task in chat; `/plugin-hint on` / `off` controls proactive hints and `/plugin-hint status` shows the current state.

## The problem it solves

- **Too many plugins, hard to find prior work — and you should not have to know the plugin's name first**: with 10,000+ entries, keyword search only tells you whether a few characters appear in a name; many tasks start from scratch while proven solutions sit unused. The advisor breaks the task into keywords (Chinese and English aliases, multiple queries), finds the entry that is already built and worth reusing or building on with quality facts, and surfaces its repository, license, and `dsh.bundle.patch` path.
- **Finding one is not the same as being able to use it**: READMEs are written for authors, so non-experts do not know what to prepare, what the first step is, or how to verify. The advisor turns the README and package manifest into a grounded onboarding card (prerequisites / 3 steps / examples / verification / troubleshooting / uninstall) and marks what the README does not say instead of filling in the gaps.
- **A quick try rarely unlocks the plugin's real value**: value comes from the right scenario, configuration, and prompts. On a high-confidence match the advisor asks whether to use the plugin, then provides copy-paste examples and the key configuration points — instead of leaving it installed but unused.

## What it does

- **Find plugins by goal**: turns "convert this PDF to Markdown while keeping formulas" into Chinese and English keywords and returns candidates with quality facts, capability disclosure, deprecation/replacement, and install specs.
- **Judge quality**: maintenance activity, documentation completeness, license, host requirement, capability red lines; stars and downloads are reference only.
- **Provide onboarding steps**: extracts prerequisites / 3 steps / configuration / examples / verification / troubleshooting / uninstall from the README and manifest; explicitly marks missing sections.
- **Check whether you can build on it**: repository, license, `dsh.bundle.patch` path, and manifest highlights.
- **High-confidence proactive hints**: enabled by default, but only when the match is strong enough. Once triggered it follows the "soft gate" — asks before switching to a plugin instead of switching silently.

## Soft gate

When the match is strong and the task's core outcome is what the plugin is good at (PDF layout/formulas, scanned-document OCR, Excel formulas, browser automation with a logged-in session, scheduled triggers, etc.), it asks before starting:

> This task is a better fit for `<plugin name>`: <one-line reason>. Should I install it and use it, or do it with what's already available?

- User says "use the plugin" → show source and capability disclosure, install, then complete the task.
- User says "just do it" → complete it with built-in capabilities and do not mention the plugin again for this task.
- Ordinary coding, file edits, search, summaries, and Q&A do not trigger it; weak matches do not trigger it either.

## Toggle

- Proactive hints are **on by default** (`proactive: true`), but only high-confidence matches trigger them.
- Per session: `/plugin-hint off`, `/plugin-hint on`, `/plugin-hint status` (takes effect immediately; writes no files).
- Persistent default: change `proactive` under `config:` in the profile patch.
- At most one hint per 3 user messages in a session; slash commands, short replies, system notices, and messages that already mention plugins do not trigger it.

## Tools

| Tool | Purpose |
|---|---|
| `plugin_search` | Search the catalog with multiple keyword groups |
| `plugin_inspect` | One plugin's details, README excerpt, similar/alternative entries, build-on information |
| `plugin_guide` | A grounded onboarding card |

The `plugin-advisor` skill guides the agent's search, judgment, recommendation, installation, and onboarding format.

## Configuration (all optional)

| Key | Default | Description |
|---|---|---|
| `proactive` | `true` | Persistent default for high-confidence proactive hints |
| `catalogUrl` | official catalog | Catalog URL; also via `PLUGIN_ADVISOR_CATALOG_URL` / `DSHM_REGISTRY_URL` |
| `githubToken` | empty | Raises GitHub API rate limits; also via `PLUGIN_ADVISOR_GITHUB_TOKEN` |
| `readmeChars` | `1200` | README excerpt length for `plugin_inspect` (400–4000) |
| `profile` | `DSH_PROFILE` | Profile name used in the install/uninstall commands of onboarding cards |

## Data sources

- Catalog: `plugins.json` from the `dsh-plugin-catalog` npm package (a ~4 MB tarball, downloadable in seconds; 30-minute in-memory cache; when a refresh fails, a cache younger than 6 hours is returned with a stale marker). The official JSON `https://awesome-dsh-plugin.com/plugins.json` is the fallback; `catalogUrl` / `PLUGIN_ADVISOR_CATALOG_URL` / `DSHM_REGISTRY_URL` can point at a mirror.
- npm manifests and READMEs: `https://registry.npmjs.org/<pkg>/latest`.
- GitHub READMEs and repository facts: `https://api.github.com` (60 requests/hour unauthenticated).
- `raw.githubusercontent.com` / `cdn.jsdelivr.net` are not used (measured unreachable on the target network).

## Privacy

- No telemetry is collected or uploaded; queries are searched in local memory only.
- Tokens, local paths, and secrets are never printed; a GitHub token is read only from configuration/environment variables.
- The plugin never installs anything itself; installation is performed by the agent through `plugin_manager` after you confirm.

