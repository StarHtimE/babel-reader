# CLAUDE.md

给 Claude Code 的项目上下文。面向用户的说明见 README.md。

## 语言约定（始终有效）

- **与用户的所有交流一律用简体中文**：回复、提问、进度说明、结尾总结、任务列表和收尾框的文字都用中文。用户用中文提问时，绝不切换成英文
- **上下文压缩后同样适用**：压缩生成的摘要用中文写；从摘要继续工作时，即使摘要或工具输出里有英文，也继续用中文回复
- 提交信息用中文（沿用 `feat: …` / `fix: …` / `chore: …` 前缀）；代码注释、UI 文案、README、CLAUDE.md 用中文
- 保留英文的只有：代码标识符、命令、路径、日志与报错原文、上游项目的专有名词

## 项目概况

Babel Reader = Obsidian 插件 + 本地翻译服务。对仓库内的 PDF 调用 BabelDOC（经 pdf2zh_next）生成保留排版的译文（mono）和左右对照版（dual），并在 PDF 视图里切换 原文 / 译文 / 对照。

当前阶段：**v0.2 已发布**（最新版本 0.2.0）。范围见文末「路线图」：开始 v0.3 前先和用户确认范围，不要提前实现路线图以外的功能。

## 目录结构

```
.                       # 插件（TypeScript）；manifest.json 必须在根目录
├── manifest.json
├── package.json / tsconfig.json / esbuild.config.mjs
├── styles.css
├── src/
│   ├── main.ts         # 入口：只做注册（命令、事件、视图按钮、设置页），不放业务逻辑
│   ├── settings.ts
│   ├── core/           # 纯逻辑，禁止 import 'obsidian'：页码映射、命名、manifest 校验、multipart 构造、标题识别
│   ├── api/            # 与服务通信：requestUrl 封装、轮询
│   ├── store/          # manifest 读写、原文 ⇄ 译文索引
│   ├── jobs/           # 任务队列、进度、取消
│   ├── launcher/       # 桌面端按需启动本机服务（唯一使用 Node 模块的地方）
│   ├── rename/         # 按论文标题重命名：用 pdf.js 读首页、确认弹窗
│   ├── glossary/       # 术语表笔记：合并后随任务提交，自动抽取的术语写回「待审核」
│   └── view/           # PDF 视图头部按钮、模式切换、读当前页号
├── tests/              # vitest；主要覆盖 src/core
└── server/             # Python 翻译服务（AGPL-3.0，单独的 LICENSE）
    ├── pyproject.toml
    ├── config.example.toml   # config.toml 必须在 .gitignore 里
    ├── src/babel_reader_server/
    │   ├── cli.py         # serve / warmup 子命令
    │   ├── app.py         # FastAPI 路由
    │   ├── jobs.py        # 任务状态与队列（串行执行）
    │   ├── translate.py   # 唯一 import pdf2zh_next 的模块
    │   └── config.py
    └── tests/
```

## 常用命令

插件（项目根目录）：
- `npm install`
- `npm run dev`：esbuild watch
- `npm run build`：`tsc --noEmit` + 生产构建
- `npm run lint`：eslint
- `npm test`：vitest

服务（`server/`）：
- `uv sync`
- `uv run babel-reader-server serve --port 8891`
- `uv run babel-reader-server warmup`
- `uv run pytest`
- `uv run ruff check . && uv run ruff format --check .`

改完代码，先跑通相关部分的 build / lint / test，再报告完成。

发版：`package.json`、`manifest.json` 的 `version` 一起改，`versions.json` 加一行 `"<版本>": "<minAppVersion>"`；提交后推送同名标签（不带 `v`，如 `0.1.0`），`.github/workflows/release.yml` 会构建并创建草稿 Release，由用户在 GitHub 网页上检查后发布。

## 开发环境

- 在原生 Windows 下开发，不用 WSL。Node、uv、Python 都用 Windows 版；Claude Code 的命令经 Git Bash 或 PowerShell 执行。
- 本机路径（项目目录、测试仓库）写在 `CLAUDE.local.md`，该文件不提交。
- 插件输出目录写在根目录的 `.env`（不提交）：`OBSIDIAN_PLUGIN_DIR=<测试仓库>\.obsidian\plugins\babel-reader`。`esbuild.config.mjs` 在 `.env` 存在时用 Node 内置的 `process.loadEnvFile()` 读取；设置了就把 `main.js`、`manifest.json`、`styles.css` 复制过去，并放一个空的 `.hotreload` 文件，配合测试仓库里的 Hot Reload 插件（pjeby/hot-reload）自动重载；没设置就只构建不复制。
- 只在测试仓库里调试，**绝不读写用户的主仓库**（主仓库会同步到多台设备）。测试仓库里的 PDF 是测试原文，不得修改或删除。
- Claude 桌面版是 MSIX 打包应用：在它的终端里运行的程序写 `%APPDATA%` / `%LOCALAPPDATA%` 时会被重定向到 `AppData\Local\Packages\Claude_*\LocalCache\`，Obsidian 和用户自己的终端看不到。因此 `uv python install` 这类安装到 AppData 的操作必须由用户在普通终端里执行，否则 `.venv` 指向的 Python 在 Claude 之外不存在（venv 启动器报 `No Python at`，退出码 103）
- npm scripts 必须在 PowerShell 和 Git Bash 下都能运行：不写 `cp`、`rm -rf`、`export VAR=...` 这类 shell 语法，文件操作放进 Node 脚本。
- 原生 Windows 下 Claude Code 没有 Bash 沙箱：命令只作用于项目目录和测试仓库，不改系统设置，不全局安装包，不动其他目录。

### Windows 注意事项（服务端）

- 中文 Windows 控制台默认 GBK：`cli.py` 启动时对 stdout / stderr 调 `reconfigure(encoding="utf-8")`，日志文件显式用 UTF-8 打开。
- 被打开的文件不能删除或覆盖：先关闭句柄再移动或删除；临时目录用 `tempfile.TemporaryDirectory(ignore_cleanup_errors=True)`。
- 路径一律用 `pathlib`，不手拼分隔符；文件名可能含中文和空格。
- 以后加 CI 时，服务端测试同时跑 `windows-latest` 和 `ubuntu-latest`。

## 核心约束（不得违反）

1. **页码恒等。** 原文、mono、dual 的第 N 页必须对应同一内容。切换模式 = 读当前页号 → 打开另一个文件的 `#page=N`。因此：
   - dual 只用左右并排，禁止交替页（`use_alternating_pages_dual`）
   - 部分翻译时禁止 `only_include_translated_page`，未翻译的页保留原文
   - 允许 `dual_translate_first`（只影响左右顺序）
2. **原文是正本。** 链接、反链、高亮只落在原文；插件永远不修改原文的内容；译文只写进译文目录。
   - 唯一例外是改名：只有用户在「按论文标题重命名」弹窗里确认后，用 `app.fileManager.renameFile` 改文件名（Obsidian 据此更新链接），不移动到别的文件夹
   - 原文改名 / 移动后，译文跟随（`src/core/relocate.ts`）：只改插件生成的译文目录名和文件名，用户手动改过的不动
   - 原文被删除时只询问、默认保留译文；删除译文用 `fileManager.trashFile`（遵循用户的回收站设置）
3. **Obsidian 开发者政策。**
   - 插件不得安装或更新自身及其依赖：不在插件里执行 uv / pip / npm，不下载服务端
   - 允许启动用户**已安装**的服务（`src/launcher/`）：只运行 `<服务目录>/.venv` 里现成的 `babel-reader-server`，不用 `uv run`（它会自动同步依赖）。仅在点翻译或「测试连接」且连不上本机地址时启动，不随 Obsidian 启动；只结束自己启动的进程（整棵进程树），在 `onunload` 和 `workspace.on('quit')` 时结束
   - 运行外部程序、访问仓库外文件都要在 README 的「隐私与网络」里写明
   - 网络访问只限用户配置的服务地址；新增任何网络行为都要同步更新 README 的「隐私与网络」
   - 不加遥测，不混淆代码
4. **移动端可用。** `manifest.json` 里 `isDesktopOnly: false`，因此：
   - 不在顶层 import Node / Electron 模块（`fs`、`path`、`child_process`、`electron`）；确需使用时（只有 `src/launcher/`）先判断 `Platform.isDesktopApp`，再在函数内 `window.require`，类型用手写的最小接口，不引入 `@types/node`
   - 网络请求统一用 `requestUrl`（没有 CORS 问题，移动端可用），不用 `fetch` / `EventSource`
   - 哈希用 Web Crypto：`crypto.subtle.digest('SHA-256', buf)`
   - 文件读写用 Vault API（`readBinary` / `createBinary` / `modifyBinary`），不用 Adapter API；用户给的路径一律过 `normalizePath`
5. **密钥不进仓库。** 大模型 API key 只能存在两处：服务端 `config.toml`，或 Obsidian 的密钥存储（`app.secretStorage`，设置页用 `SecretComponent`）。插件的 `data.json` 只记录密钥的名称（`secretId`），永远不写密钥本身。
   - 插件只在提交任务时取出密钥，放进 `options.llm` 发给服务；服务地址既不是本机也不是 https 时拒绝发送（`canSendSecretTo`）
   - 服务端用 `SecretStr` 接收，交给翻译前从 `options` 里去掉；日志、任务状态、校验错误里都不得出现密钥明文
   - manifest 里只记配置名，不记密钥
6. **AGPL 边界。** 插件代码不得 import、复制或改写 BabelDOC / pdf2zh_next 的代码，两边只通过下面的 HTTP 接口交互。服务端只有 `translate.py` 直接依赖 pdf2zh_next。

## 插件 ⇄ 服务 HTTP 接口（v1）

路径前缀统一为 `/v1`。配置了令牌时，请求必须带 `Authorization: Bearer <token>`。服务默认只监听 `127.0.0.1`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | `{ok, server_version, pdf2zh_next_version, babeldoc_version, features}`；`features` 列出可选功能，含 `"llm"` 表示接受 `options.llm`，含 `"glossary"` 表示接受 `options.auto_extract_glossary` 并返回自动抽取的术语（旧版服务端没有此字段） |
| GET | `/profiles` | `{profiles: [名称, ...]}`（不含 key） |
| POST | `/jobs` | `multipart/form-data`：`file`（PDF）+ `options`（JSON 字符串）→ `{job_id}` |
| GET | `/jobs/{id}` | `{state, stage, stage_progress, overall_progress, error?, outputs?, extras?}`；`outputs` 只在 `done` 时出现，为 PDF 种类列表如 `["mono","dual"]`；`extras` 同时出现，列出额外结果如 `["glossary"]`（单独列出，旧版插件只认得 mono / dual） |
| DELETE | `/jobs/{id}` | 取消；运行中的任务通过 cancel 对应的 asyncio task 中止；已结束的任务则丢弃其结果文件 |
| GET | `/jobs/{id}/files/{kind}` | `kind` 为 `mono` 或 `dual` 时返回 PDF 字节；为 `glossary` 时返回自动抽取的术语 CSV（`source,target,tgt_lng`） |

- `state` 取值：`queued | running | done | error | cancelled`
- 进度靠**轮询**（插件约每秒 `GET /jobs/{id}` 一次），不用 SSE / WebSocket：`requestUrl` 不支持流式响应，长连接在 Windows 上也容易出错
- `requestUrl` 不会自动构造 multipart，由 `src/core/multipart.ts` 手动拼 body
- 服务端串行执行任务；已完成任务的结果保留约 1 小时后清理

`options`：

```json
{
  "lang_in": "en",
  "lang_out": "zh",
  "profile": "deepseek",
  "llm": null,
  "pages": null,
  "outputs": ["mono", "dual"],
  "dual_translate_first": false,
  "ignore_cache": false,
  "glossary_csv": null,
  "auto_extract_glossary": true
}
```

- `glossary_csv`：插件把术语表笔记合并后转成的 CSV（`source,target,tgt_lng`）；`auto_extract_glossary` 映射到上游的 `no_auto_extract_glossary`（取反）

服务端负责把 `options` 映射到 pdf2zh_next 的 `SettingsModel`，并固定使用无水印输出。

`llm` 为插件设置里的大模型配置，提供时优先于 `profile`（插件此时把 `profile` 置为 `null`）：

```json
{
  "name": "DeepSeek",
  "base_url": "https://api.deepseek.com",
  "api_key": "sk-...",
  "model": "deepseek-chat",
  "qps": 4,
  "temperature": null,
  "timeout": null,
  "extra_body": { "thinking": { "type": "disabled" } }
}
```

`temperature` / `timeout` 为数字字符串或 `null`（不发送）。服务端没有任何 profile 时，只能使用 `llm`。

## 译文在仓库里的布局

```
<translationsDir>/<原文 basename>-<6 位短 ID>/
├── <basename>.<lang_out>.mono.pdf
├── <basename>.<lang_out>.dual.pdf
└── manifest.json
```

- 译文目录名和文件名里的 basename 最多 60 个字符（`TRANSLATION_BASE_MAX`，在词边界截断）：basename 在路径里出现两次，不限长时完整路径会超过 Windows 的 MAX_PATH（260），Obsidian 的 PDF 视图打不开（空白、0/0 页）。旧版不限长的名字仍算插件生成的，原文改名 / 移动或重新翻译时改成短名字

`manifest.json`（`schema` 升级时必须写迁移代码）：

```json
{
  "schema": 1,
  "id": "a1b2c3",
  "source": { "path": "Papers/xxx.pdf", "sha256": "..." },
  "lang": { "in": "en", "out": "zh" },
  "outputs": { "mono": "xxx.zh.mono.pdf", "dual": "xxx.zh.dual.pdf" },
  "options": { "pages": null, "profile": "deepseek", "glossary": "Glossary/SAR.md" },
  "engine": { "server": "0.1.0", "pdf2zh_next": "...", "babeldoc": "..." },
  "createdAt": "2026-11-20T12:00:00Z"
}
```

- 插件启动时扫描所有 manifest，建立 原文路径 ⇄ 译文 的双向索引；用户直接打开译文文件时也要能反查到原文
- `vault.on('rename')` 时更新 `source.path`，文件名变了时译文目录和文件一起改名；`vault.on('delete')` 删除原文时提示是否一并删除译文（同一次操作的多个删除合并成一次询问）
- 原文 sha256 与 manifest 不一致 → 标记为过期，不自动重译。只在打开有译文的 PDF 时、批量翻译前计算哈希，不在启动时扫描全部；按 修改时间 + 大小 缓存（`src/store/stale-checker.ts`）。过期状态只在内存里，不写进 manifest
- 不依赖 BabelDOC 的输出文件命名规则：以服务返回的结果为准，再按上面的规则命名写入

## 代码约定

- TypeScript 开 strict，不用 `any`；外部数据（服务响应、manifest）在 `core/` 里做运行时校验
- 所有事件和 DOM 监听都用 `this.registerEvent` / `this.registerDomEvent` / `this.register` 注册，保证 `onunload` 能清理干净
- UI 文案用简体中文；样式写成 `styles.css` 里的类，不写内联样式，不用 `innerHTML`
- 设置页分组标题用 `new Setting(el).setHeading()`
- 所有 Obsidian 非公开 API（如 PDF 视图的当前页号、跳页）集中放在 `src/view/pdf-internals.ts`：每处都要有类型守卫和失败回退（读不到页号就从第 1 页打开），并注明参考来源（PDF++ 源码）
- Python 3.12，用 ruff，写类型注解；`translate.py` 以外不 import pdf2zh_next / babeldoc
- 测试不调用真实的大模型：服务端用假的事件流替换 `do_translate_async_stream`

## 已查证的上游细节（升级上游版本时要重新核对）

依据 pdf2zh_next 2.10.2 / BabelDOC 0.7.1 源码（`server/.venv/Lib/site-packages/`）：

- `SettingsModel` 字段：`translation.{lang_in, lang_out, output, qps, ignore_cache, glossaries}`（`glossaries` 是逗号分隔的 CSV 路径）；`pdf.{pages, no_mono, no_dual, dual_translate_first, use_alternating_pages_dual, only_include_translated_page, watermark_output_mode}`（无水印取 `"no_watermark"`）；大模型接口直接用 `OpenAISettings`（不用 `OpenAICompatibleSettings`：它的 `transform()` 不传 extra_body，也不开 temperature 的发送开关 `openai_send_temprature`——上游拼写如此）；profile 的 `extra_body` 写进私有字段 `_openai_extra_body`，`OpenAITranslator` 会放进每次请求并计入缓存键。`get_translator()` 构造时会探测接口，测试里直接构造 `OpenAITranslator`
- `do_translate_async_stream(settings, file)` 产出 `progress_start / progress_update / progress_end / finish / error` 事件；进度字段 `stage, stage_progress, overall_progress`（`progress_start` / `progress_end` 没有 `overall_progress`）；完成事件 `event["translate_result"].mono_pdf_path / dual_pdf_path`
- 翻译在子进程里跑；取消正在 await 该生成器的 asyncio task 即可，生成器的 `finally` 会结束子进程
- warmup 入口：`babeldoc.assets.assets.warmup()`
- 术语表：`Glossary.from_csv` 要求列 `source,target`，`tgt_lng` 可选（与 `lang_out` 比较时忽略大小写、`-` 当 `_`）。自动抽取默认开启（`translation.no_auto_extract_glossary=False`，主引擎支持 LLM 时用同一个引擎）；pdf2zh_next 的 `create_babeldoc_config` 不传 `save_auto_extracted_glossary`，所以用 BabelDOC 的默认值 `True`：抽到的术语以 utf-8-sig 写成 `<basename>.<lang_out>.glossary.csv`，路径在 `translate_result.auto_extracted_glossary_path`
- 并发：每个任务一个子进程，理论上可并发；目前仍串行：插件一次只提交一篇，其余在插件的队列里等（`src/core/queue.ts`）
- 读 PDF 首页：公开 API `loadPdfJs()`（Obsidian 内置 pdf.js，移动端可用），返回类型是 `any`，在 `src/rename/read-first-page.ts` 里逐个方法做类型守卫；文本项 `{str, transform, width}`，字高取 `hypot(transform[2], transform[3])`，`transform[0] > 0 且 transform[1] ≈ 0` 才是横排文字（arXiv 左侧编号是旋转的）；元数据 `getMetadata()` → `info.Title` 与 XMP `metadata.get("dc:title")`（见过 XMP 把标题重复两遍）
- Obsidian PDF 视图页号：`view.viewer.child.pdfViewer.pdfViewer.currentPageNumber`（1 起），回退 `view.getState().page`；跳页用公开的 `leaf.openFile(file, { eState: { subpath: "#page=N" } })`（参考 PDF++ `src/typings.d.ts`）

## 路线图

- **v0.1**（已发布 0.1.0、0.1.1）：设置页 + 测试连接；「翻译当前 PDF」；状态栏进度与取消；写入译文目录和 manifest；视图头部三态切换并保持页码；点翻译或测试连接时按需自动启动本机服务（默认开启）；在插件设置里配置大模型（API key 存 Obsidian 密钥存储，minAppVersion 1.11.4）
- **v0.2**（已发布 0.2.0）：术语表（已完成；Markdown 笔记表格，全局 + 文件夹术语表，自动抽取的术语过滤后按论文分组追加到「待审核」小节、不自动生效，写回可单独关闭）；指定页翻译（已完成；命令和文件右键菜单，结果替换已有译文、不合并）；右键批量翻译与队列（已完成；队列在插件端，状态栏 + 队列弹窗；配置或连接错误停下整个队列，单篇失败不影响后面）；批量「按论文标题重命名」（已完成；一个列表弹窗统一确认）；过期检测（已完成）；重命名 / 删除跟踪（已完成）；按论文标题重命名：首页文字 + PDF 元数据（已完成；以后可加「让大模型识别」作为补充）；术语表（笔记表格或 CSV → 传给服务；自动抽取的术语回写待审核）
- **v0.3**：原文与译文双 pane 同步滚动；移动端裁剪阅读；局域网远程服务（令牌鉴权）
