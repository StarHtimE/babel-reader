# Babel Reader

> 在 Obsidian 里一键生成保留排版的 PDF 译文，并在「原文 / 译文 / 对照」之间切换，切换后停在同一页。

**状态：v0.1.1**，可从 [Releases](https://github.com/StarHtimE/babel-reader/releases) 下载。尚未上架 Obsidian 社区插件目录，需要手动安装（见「安装」）。只在 Windows 桌面端测试过。

## 它做什么

- 对仓库里的 PDF 一键翻译，输出两份 PDF：
  - **译文**：保留原排版、公式和图表，只把文字换成目标语言
  - **对照**：原文和译文左右并排在同一页
- 在 PDF 视图顶部切换 **原文 / 译文 / 对照**，切换后停在同一页（三份文件的第 N 页始终是同一内容）
- 一键识别论文标题，把 `2108.13342v2.pdf` 这类文件名改成论文标题；改名前会让你确认
- 原文是唯一正本：插件从不修改原文内容，笔记里的链接、反链、高亮都指向原文；译文只写进单独的译文目录。原文改名、移动后译文自动跟随
- 翻译引擎是 [BabelDOC](https://github.com/funstory-ai/BabelDOC)，通过 [PDFMathTranslate-next](https://github.com/PDFMathTranslate/PDFMathTranslate-next)（pdf2zh_next）调用，大模型用任意 OpenAI 兼容接口（如 DeepSeek）

## 工作方式

插件本身不做翻译。翻译由一个单独运行的本地服务完成，代码在本项目的 `server/` 目录：

```
Obsidian 插件 ──HTTP──▶ Babel Reader Server ──▶ pdf2zh_next / BabelDOC ──▶ 你配置的大模型 API
      ▲                                                     │
      └──────────── 译文 PDF（mono / dual）◀────────────────┘
```

- 插件把 PDF 上传给服务、每秒查询一次进度，完成后把译文写回仓库
- 点击翻译或「测试连接」时如果服务没在运行，插件会在后台自动启动它（桌面端，可在设置里关闭）；也可以自己手动启动
- 服务默认只监听本机 `127.0.0.1`
- 大模型的 API key 保存在 Obsidian 的密钥存储里，或服务端的 `config.toml` 里，都不会写进仓库的笔记或插件设置文件

## 环境要求

- **Obsidian** 1.11.4 或更高版本（桌面端；插件用到它的密钥存储）
- **翻译服务**：[uv](https://docs.astral.sh/uv/)（会自动下载所需的 Python 3.12，不用单独装 Python）；首次运行需要下载约 300 MB 的版面模型和字体
- **[Git](https://git-scm.com/)**：用来下载和更新服务端源码（也可以直接下载源码压缩包）
- **一个 OpenAI 兼容的大模型 API**，如 DeepSeek，或本地运行的 OpenAI 兼容服务

安装 uv：

```powershell
# Windows
winget install astral-sh.uv
```

```bash
# macOS / Linux
curl -LsSf https://astral.sh/uv/install.sh | sh
```

## 安装

### 1. 下载源码

翻译服务没有单独的安装包，需要源码里的 `server/` 目录：

```bash
git clone https://github.com/StarHtimE/babel-reader.git
cd babel-reader
```

也可以在 [Releases](https://github.com/StarHtimE/babel-reader/releases) 下载对应版本的「Source code (zip)」解压。用 Git 的好处是以后 `git pull` 就能更新。

### 2. 安装翻译服务

```bash
cd server
uv sync                              # 安装依赖（首次较慢）
cp config.example.toml config.toml   # 服务端配置；大模型可以在这里配，也可以在插件设置里配
uv run babel-reader-server warmup    # 只需一次：下载并校验版面模型和字体
```

- `warmup` 只需要跑一次。跳过的话，第一次翻译会先下载模型，看起来像卡住了
- 服务不用手动启动：在插件设置里填好「服务目录」（第 4 步）后，点翻译或「测试连接」时插件会自动在后台启动它
- 想手动启动（比如不用自动启动，或想看实时输出）：`uv run babel-reader-server serve`，默认监听 `127.0.0.1:8891`，翻译期间不要关掉这个终端

大模型接口有两种配置方式，任选其一：

- **在插件设置里配置**（推荐）：见第 4 步。API key 保存在 Obsidian 的密钥存储里。这时 `config.toml` 里可以没有 `[[profiles]]`，只保留 `[server]` 一节
- **在 `config.toml` 里配置**：API key 只留在服务端这台电脑上，适合不想在 Obsidian 里存密钥的情况

```toml
[server]
host = "127.0.0.1"
port = 8891
token = ""            # 访问令牌；只在本机使用时可留空

# 只在 config.toml 里配置大模型时需要
[[profiles]]
name = "deepseek"
base_url = "https://api.deepseek.com"
api_key = "sk-..."
model = "deepseek-chat"
qps = 4
extra_body = { thinking = { type = "disabled" } }   # 关闭思考，见下
```

**关于思考模式：** 默认开启思考的模型（如 DeepSeek）会先推理每一段再翻译，速度会慢很多倍。实测一篇 17 页的论文，开着思考约 23 分钟，关掉后约 2 分钟。插件设置里直接打开「关闭思考」开关即可（会按接口地址发送对应服务商的字段）；`config.toml` 里则要自己写 `extra_body`，DeepSeek 等是 `{ thinking = { type = "disabled" } }`，通义千问是 `{ enable_thinking = false }`。完整的配置项见下文「服务端配置参考」。

### 3. 安装插件

任选一种：

**手动安装**

1. 从 [最新 Release](https://github.com/StarHtimE/babel-reader/releases/latest) 下载 `main.js`、`manifest.json`、`styles.css` 三个文件
2. 在你的仓库里新建文件夹 `<仓库>/.obsidian/plugins/babel-reader/`（文件夹名必须是 `babel-reader`），把三个文件放进去
3. 在 Obsidian 的「设置 → 第三方插件」里关闭「安全模式」（新版本叫「受限模式」），刷新插件列表，启用 **Babel Reader**

**用 BRAT 安装**（以后可以自动更新）

装好社区插件 [BRAT](https://github.com/TfTHacker/obsidian42-brat) 后，运行命令「BRAT: Add a beta plugin for testing」，填入 `StarHtimE/babel-reader`，再在「第三方插件」里启用 **Babel Reader**。

**从源码构建**（需要 [Node.js](https://nodejs.org/) 22 或更高版本）：在项目根目录运行 `npm install` 和 `npm run build`，生成的 `main.js` 和 `manifest.json`、`styles.css` 一起按手动安装的第 2、3 步放进插件文件夹。

插件不会安装或更新翻译服务及其依赖，服务需要按第 2 步自行安装。

### 4. 连接服务

打开「设置 → Babel Reader」：

1. 「服务目录」填 `server` 文件夹的完整路径，如 `D:\babel-reader\server`，点「检查」确认找得到服务程序和 `config.toml`
2. 确认服务地址是 `http://127.0.0.1:8891`
3. 点「测试连接」：服务没在运行时插件会先自动启动它（几秒钟），成功时显示服务和引擎的版本号
4. 在「大模型」一节点「添加大模型配置」，填写接口地址和模型，在「API key」里新建一条密钥并粘贴 key；DeepSeek、通义千问等默认开启思考的模型建议打开「关闭思考」。然后在「使用的配置」里选中它
   - 用 `config.toml` 里的 profile 时：点「使用的配置」旁边的刷新按钮，选择「服务端：…」

## 使用

### 翻译

打开一个 PDF，点视图顶部的 **翻译** 按钮（语言图标），或运行命令「翻译当前 PDF」，也可以在文件列表里右键 PDF 选「翻译此 PDF」。

- 服务没在运行时，状态栏先显示「启动翻译服务…」，通常几秒钟
- 状态栏显示进度和当前阶段；**点击状态栏**（或运行命令「查看翻译队列」）打开翻译队列，可以取消单篇或全部；命令「取消全部翻译」可以绑定快捷键
- 一次翻译一篇，其余排队；正在翻译时再点翻译，会加入队列
- 完成后译文写入译文目录（默认 `_translations/`），原文不会被改动

### 批量翻译

在文件列表里右键一个 **文件夹**（包括子文件夹），或多选几个 PDF 后右键，选「翻译文件夹内的 PDF」/「翻译选中的 PDF」。

- 先弹窗说明找到几篇、几篇已有译文；已有译文的默认跳过，可以勾选「已有译文的也重新翻译」
- 译文目录里的文件不会被当作原文
- 状态栏显示「翻译 3/12 …」；全部结束后提示完成、失败、取消各几篇，失败原因在翻译队列里查看
- 某一篇失败不影响后面的；连不上服务、大模型配置有问题这类会让后面都失败的错误，会停下整个队列

### 切换

已有译文的 PDF，视图顶部会出现这些按钮：

| 按钮 | 作用 |
|---|---|
| 文件图标 | 切换到原文 |
| 语言图标 | 切换到译文 |
| 书本图标 | 切换到对照（左右并排） |
| 刷新图标 | 重新翻译当前 PDF（只在原文上出现） |
| 铅笔图标 | 按论文标题重命名（只在原文上出现，见下文） |

切换时停在当前页。直接打开译文文件，也会显示这组切换按钮。三条切换命令「切换到原文 / 译文 / 对照」可以在「设置 → 快捷键」里绑定快捷键。

### 按论文标题重命名

打开一个 PDF，点视图顶部的 **铅笔图标**，或运行命令「按论文标题重命名当前 PDF」，也可以在文件列表里右键 PDF 选「按论文标题重命名」。

**批量**：右键文件夹或多选的 PDF，选「按论文标题重命名文件夹内的 PDF」/「…选中的 PDF」。插件逐篇识别标题后，在一个列表里显示每篇的原文件名、识别到的标题和可修改的新文件名；识别失败的、文件名已经是标题的默认不勾选，确认后一起改名。同一批里的新文件名不会互相撞名。

- 插件读取 PDF 首页，取页面上方字号最大的那段文字作为标题（跨行会自动拼接），同时参考 PDF 自带的标题元数据；两者不一致时，弹窗里可以改用另一个
- 弹窗里显示建议的文件名，可以先修改再确认，不会悄悄改名
- 冒号换成「 - 」，其他不能用在文件名里的字符（`\ / * ? " < > |`，以及会破坏 Obsidian 链接的 `# ^ [ ]`）会替换或去掉；过长的标题在词边界截断；同一文件夹里重名时自动加序号
- 用 Obsidian 自己的重命名功能改名：笔记里指向它的链接按「设置 → 文件与链接 → 自动更新内部链接」处理
- 已有译文时，译文目录和译文文件也会一并改成新名字
- 全程在本机完成，不联网；扫描版（首页没有文字层）识别不出标题，会给出提示

### 重新翻译、改名与删除

- **重新翻译** 会覆盖同一目录里的译文。参数相同时会复用服务端的翻译缓存，所以很快
- **原文改名或移动**（不论是否用上面的按钮）：译文自动跟随，manifest 里记录的原文路径随之更新；改了文件名时，插件生成的译文目录名和文件名也会一并改名（你手动改过的名字不动）
- **删除原文**：插件会询问是否把它的译文也删除，默认保留。保留的译文在原文从回收站恢复后会自动重新关联
- **删除译文**：直接删除 `_translations/` 下对应的文件夹即可，按钮会立即恢复成「翻译」

## 设置

设置 → Babel Reader：

| 选项 | 说明 | 默认值 |
|---|---|---|
| 服务地址 | 翻译服务的 URL，旁边有「测试连接」按钮 | `http://127.0.0.1:8891` |
| 访问令牌 | 与服务端 `token` 一致；服务端没设令牌时留空 | 空 |
| 自动启动服务 | 点翻译或「测试连接」时连不上本机服务就在后台启动它（仅桌面端、仅本机地址） | 开 |
| 服务目录 | `server` 文件夹的完整路径；旁边有「检查」按钮 | 空 |
| 使用的配置 | 插件里添加的大模型配置，或 `config.toml` 里的 profile（刷新按钮从服务端读取） | 服务端第一个 |
| 大模型配置 | 名称、接口地址、模型、API key（存在 Obsidian 的密钥存储里）、关闭思考、每秒请求数、温度、超时，以及高级的额外请求参数（JSON） | 无 |
| 源语言 / 目标语言 | 语言代码 | `en` → `zh` |
| 生成对照版 | 关闭则只生成译文 | 开 |
| 对照版译文在左 | 只影响对照版左右顺序，不影响页码 | 关 |
| 译文目录 | 译文和清单的存放位置（仓库内路径），修改后会重新扫描 | `_translations` |

## 文件布局

```
_translations/
└── <原文文件名>-<6 位短 ID>/
    ├── <原文文件名>.zh.mono.pdf   # 译文
    ├── <原文文件名>.zh.dual.pdf   # 对照
    └── manifest.json             # 原文路径、哈希、翻译参数、引擎版本
```

每篇论文会多出两份 PDF。如果仓库跨设备同步，可以关闭「生成对照版」，或者在同步工具里排除 `_translations/`。

## 服务端配置参考

`server/config.toml`（已在 `.gitignore` 中，不会被提交）：

| 配置项 | 说明 | 默认值 |
|---|---|---|
| `[server] host` | 监听地址 | `127.0.0.1` |
| `[server] port` | 端口 | `8891` |
| `[server] token` | 访问令牌；设置后插件必须填写相同的令牌 | 空 |
| `[server] work_dir` | 任务临时文件的位置 | 系统临时目录 |
| `[server] result_ttl_seconds` | 已完成任务的结果在服务端保留多久 | `3600` |
| `[server] max_upload_mb` | 上传 PDF 的大小上限 | `200` |
| `[[profiles]]` | 可选；在插件设置里配置大模型时可以没有 | 无 |
| `[[profiles]] name` | 名称，插件按它选择 | 必填 |
| `[[profiles]] base_url` / `api_key` / `model` | OpenAI 兼容接口的地址、密钥、模型 | 必填 |
| `[[profiles]] qps` | 每秒请求数上限 | `4` |
| `[[profiles]] temperature` / `timeout` | 可选，填了才会发送 | 不发送 |
| `[[profiles]] extra_body` | 原样合并进每次请求体的额外字段，如关闭思考 | 不发送 |

修改 `extra_body`、`model` 等参数后，之前翻译过的段落不会命中翻译缓存，会重新调用大模型。

命令行：

```bash
uv run babel-reader-server serve [--config 路径] [--host 地址] [--port 端口]
uv run babel-reader-server --log-file server.log serve   # 同时把日志写入文件（UTF-8）
uv run babel-reader-server warmup
```

## 常见问题

- **「测试连接」失败**：提示里是自动启动失败的原因时，见下一条；关闭了「自动启动服务」时，要先手动启动服务；否则确认地址和端口正确，服务端设置了 `token` 时插件里要填相同的访问令牌
- **自动启动失败**：提示里有原因和最后几行输出；完整日志在服务目录的 `server.log`。常见原因是没运行 `uv sync`、没有 `config.toml`，或端口被其他程序占用
- **自动启动提示「No Python at …」（退出码 103）**：虚拟环境指向的 Python 不存在。常见于在 Claude 桌面版等打包应用（MSIX）的终端里运行过 `uv`：Windows 会把它写进 `AppData` 的文件重定向到该应用的私有目录，其他程序看不到。在普通的 PowerShell 里进入 `server` 目录重新运行 `uv python install 3.12` 和 `uv sync` 即可
- **自动启动提示「uv trampoline failed to canonicalize script path」（退出码 1）**：`server` 目录被移动或改过名。虚拟环境 `.venv` 里写死了原来的绝对路径，不能跟着移动。关闭 Obsidian，在 `server` 目录删除 `.venv` 后重新运行 `uv sync`，再把插件设置里的「服务目录」改成新路径
- **翻译很慢**：多半是模型开着思考模式，见上文 `extra_body`；也可以适当调高 `qps`（注意服务商的限流）
- **第一次翻译好像卡住了**：没有运行 `warmup`，服务正在下载版面模型，等它下载完即可
- **翻译失败**：弹出的提示里有服务端返回的原因（如 API key 无效、额度不足）；更详细的信息看服务端终端输出或 `--log-file` 指定的日志

## 更新

插件和服务端分开更新，最好保持同一版本：

- **插件**：从 [最新 Release](https://github.com/StarHtimE/babel-reader/releases/latest) 下载三个文件覆盖插件文件夹里的旧文件，然后在 Obsidian 里重新启用插件；用 BRAT 安装的会自动更新
- **服务端**：先关闭 Obsidian（正在运行的服务会占用虚拟环境里的文件），再在项目根目录运行：

```bash
git pull
cd server
uv sync
```

自动启动的服务会一直运行到关闭 Obsidian，所以更新服务端后重新打开 Obsidian 即可用上新版本。

## 已知限制（v0.1）

- 原文内容变化后不会提示译文过期（v0.2）
- 还不支持术语表、只翻译指定页（v0.2）
- 插件只结束自己启动的服务。手动启动的服务、以及 Obsidian 异常退出后残留的服务不会被关闭，下次翻译会直接连上它继续用
- 只在 Windows 桌面端测试过；移动端可以阅读已同步的译文，但手机连不到电脑上的本地服务，无法发起翻译（局域网服务在 v0.3）

## 隐私与网络

- 插件只连接你在设置里填写的翻译服务地址，不连接任何其他服务器，不收集遥测数据
- 翻译服务会把 PDF 里的文本发送给你配置的大模型服务商（插件设置或 `config.toml` 里的接口地址），请确认这符合你对文献内容的保密要求
- **API key**：在插件里配置的 key 保存在 Obsidian 的密钥存储里，插件设置文件 `data.json` 只记录密钥的名称。只在提交翻译任务时随请求发给你填写的翻译服务地址；服务地址既不是本机也不是 https 时，插件拒绝发送。翻译服务只用它调用大模型，不会写进日志或 `config.toml`
- 插件只读写仓库内的文件：原文（只读；只有你在「按论文标题重命名」弹窗里确认后才会改它的文件名）和译文目录。识别标题用 Obsidian 内置的 PDF 解析器在本机完成，不联网
- **仓库外的文件与外部程序**（只在开启「自动启动服务」时，仅桌面端）：插件会检查「服务目录」里的服务程序和 `config.toml` 是否存在（不读取内容），并运行 `<服务目录>/.venv` 里已安装的 `babel-reader-server`，日志写入该目录的 `server.log`。插件不运行 uv / pip，不安装或更新任何程序

## 路线图

- [x] v0.1：单篇翻译、进度与取消、三态切换（保持页码）、清单、按需自动启动服务
- [ ] v0.2：过期检测、术语表、指定页翻译；已完成：按论文标题重命名、原文改名/删除跟踪、右键批量翻译与队列、批量按标题重命名
- [ ] v0.3：原文与译文双栏同步滚动、移动端裁剪阅读、局域网远程服务

## 许可证

- 插件（项目根目录）：MIT，见 [LICENSE](LICENSE)
- 翻译服务（`server/`）：AGPL-3.0，见 [server/LICENSE](server/LICENSE)，因为它依赖同为 AGPL-3.0 的 BabelDOC 和 PDFMathTranslate-next

## 致谢

- [BabelDOC](https://github.com/funstory-ai/BabelDOC)、[PDFMathTranslate-next](https://github.com/PDFMathTranslate/PDFMathTranslate-next)：翻译引擎
- [zotero-pdf2zh](https://github.com/guaguastandup/zotero-pdf2zh)：「插件 + 本地服务」结构的先例
- [PDF++](https://github.com/RyotaUshio/obsidian-pdf-plus)：扩展 Obsidian PDF 视图的参考
