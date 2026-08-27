<p align="center">
  <a href="./README.md">English</a> · <strong>简体中文</strong>
</p>

<div align="center">
  <img src="./docs/assets/logo.png" alt="ChatGPT2LocalBridge 标志" width="160" />
  <h1>ChatGPT2LocalBridge</h1>
  <p><strong>通过安全、可审计的 MCP 桥接，让 ChatGPT 和 Codex 阅读经过授权的本地代码仓库。</strong></p>
  <p>
    <a href="https://github.com/ZhWang1104/chatgpt2localbridge/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/ZhWang1104/chatgpt2localbridge/actions/workflows/ci.yml/badge.svg" /></a>
    <img alt="Node" src="https://img.shields.io/badge/node-%3E%3D20-339933.svg" />
    <img alt="MCP" src="https://img.shields.io/badge/MCP-Streamable%20HTTP-1769e0.svg" />
    <img alt="License" src="https://img.shields.io/badge/license-MIT-blue.svg" />
  </p>
  <p>
    <a href="#快速开始">快速开始</a> ·
    <a href="#大型仓库工作流">大型仓库</a> ·
    <a href="./docs/security.md">安全模型</a> ·
    <a href="./docs/operations.md">运行维护</a>
  </p>
</div>

ChatGPT2LocalBridge 是一个面向授权本地工作区的自托管 MCP 服务。它向
ChatGPT 自定义连接器和本地 MCP 客户端提供有边界的文件、仓库、Git、Skill、
任务与诊断工具。Bridge 在你的电脑上运行；ChatGPT 不会直接挂载本地磁盘，
只能调用本地策略允许的工具。

> [!IMPORTANT]
> 本增强版基于 **Harzva** 创建的原项目
> [`Harzva/chatgpt2localbridge`](https://github.com/Harzva/chatgpt2localbridge)。
> 原作者署名、Git 历史、项目名称和 MIT 许可证均予以保留。本 fork 新增了
> 大型仓库覆盖率、可恢复扫描、AST 符号、CodeGraph 上下文、安全默认值，
> 并让 CLI、launchd 服务和 macOS 应用统一使用 TypeScript 运行时。

## 本 Fork 新增内容

- 完整的 Git 跟踪文件清单：每个跟踪路径都会被明确标记为 `indexed`、
  `binary`、`denied`、`symlink`、`missing` 或 `failed`。
- 面向超大仓库的 UTF-8 安全行分块和字节分块，支持大文件和超长单行。
- 持久化、可恢复扫描；已传递分块与已确认分块分别记录。
- TypeScript、JavaScript 和 Python 的 AST 定义/引用索引，覆盖变量、参数、
  属性、函数、类和类型。
- 可选的 CodeGraph 集成，用于补充依赖关系和影响范围上下文。
- 快照身份绑定规范路径、分支、提交、脏状态、文件哈希和分块哈希。
- 安全默认值：只读工具、`workspace:read`、仅监听回环地址、关闭 shell、
  deny glob，以及阻止符号链接逃逸的规范路径检查。
- 统一配置目录、CLI 初始化/诊断、launchd 常驻、固定 Cloudflare Tunnel
  安装器，以及可独立运行的 macOS 应用包。

## 运作方式

```text
ChatGPT / 本地 MCP 客户端
          │
          │ MCP over HTTPS + OAuth
          ▼
运行于 127.0.0.1:3838 的 ChatGPT2LocalBridge
          │
          ├─ bridge.policy.json       授权边界
          ├─ Git 清单与原文分块       完整性与源代码
          ├─ AST 符号索引             定义与引用
          ├─ CodeGraph（可选）        关系与影响范围
          └─ 已授权的本地文件         最终事实源
```

TypeScript 构建是当前支持的正式运行引擎。Rust 目录属于实验性预览，不用于
正式支持的 macOS 或 ChatGPT Connector 链路。

## 快速开始

环境要求：

- Node.js 20 或更高版本
- Git
- launchd 和原生应用仅支持 macOS
- `rg` 用于快速搜索（可选；项目内置了有上限的降级搜索）
- `codegraph` 用于关系上下文（可选）
- 只有配置固定公网连接器地址时才需要 `cloudflared`

```bash
git clone https://github.com/ZhWang1104/chatgpt2localbridge.git
cd chatgpt2localbridge
npm ci
npm run build

node dist/index.js setup --root /你的/代码仓库/绝对路径
node dist/index.js install-service
node dist/index.js doctor
```

`setup` 会创建：

```text
~/.chatgpt2localbridge/
├── .env.local           本地密钥与运行设置（权限 0600）
├── bridge.policy.json   授权根目录与拒绝规则
├── logs/
└── repositories/        清单、符号、分块与扫描状态
```

验证服务：

```bash
curl --fail http://127.0.0.1:3838/health
open http://127.0.0.1:3838/app
```

如果不安装 launchd，也可以在前台运行：

```bash
node dist/index.js start
```

也可以不克隆仓库，直接使用：

```bash
npx github:ZhWang1104/chatgpt2localbridge setup --root ~/Projects/my-repo
npx github:ZhWang1104/chatgpt2localbridge start
```

## ChatGPT 自定义连接器

托管的 ChatGPT Connector 需要稳定的 HTTPS 地址。推荐在 Cloudflare
账户中的域名上配置 Named Tunnel：

```bash
cloudflared tunnel login
node dist/index.js install-tunnel --hostname bridge.example.com
```

在支持自定义连接器的 ChatGPT 环境中创建连接器：

| 字段 | 值 |
| --- | --- |
| 名称 | `ChatGPT2LocalBridge` |
| URL | `https://bridge.example.com/mcp` |
| 身份验证 | OAuth |

本地授权页面打开后，输入 `~/.chatgpt2localbridge/.env.local` 中的 unlock
code。不要把该代码、OAuth token、Tunnel 凭据或环境文件粘贴到聊天、Issue、
截图或提交中。

Linux 主机请阅读 [Linux 部署说明](./docs/linux-deploy.md)，或运行：

```bash
curl -fsSL https://raw.githubusercontent.com/ZhWang1104/chatgpt2localbridge/main/scripts/linux-one-click-install.sh | bash
```

## 大型仓库工作流

Bridge 不会宣称单次模型上下文能够容纳整个大型仓库。它解决的是：让完整性
可以验证，让阅读过程可以中断后恢复。

```text
repo_open(projectPath)
持续调用 repo_map(snapshotId)，直到清单全部分页完成
repo_context(snapshotId, task) 获取任务相关的初始上下文
repo_scan(action=start, snapshotId)

循环：
  repo_scan(action=next, scanId)
  阅读并总结返回的分块
  repo_scan(action=ack, scanId, chunkIds, summaries)

repo_coverage(snapshotId, scanId)
```

只有满足以下条件时，才能认为完整读取已经完成：

- `trackedFiles == accountedFiles`
- 每个文本分块都已传递并得到确认
- `failedChunks == 0`
- 受支持语言的 AST failure 为空
- 不支持、二进制、拒绝和缺失文件仍然明确可见

CodeGraph 是关系层，不是完整性指标。即使 CodeGraph 未安装或覆盖的文件较少，
Git 原始清单和源代码分块仍是完整性事实源。

### 多分支

为每个分支创建一个稳定的 Git worktree，并分别调用 `repo_open`。快照包含分支、
提交、脏状态和内容哈希。文件变化后，`repo_read` 会拒绝旧快照；
`repo_compare` 可以在不切换工作区的情况下比较两个 ref。

完整约定见[大型仓库工作流](./docs/large-repositories.md)。

## 仓库工具

| 工具 | 用途 |
| --- | --- |
| `repo_open` | 建立绑定分支的清单、分块和可选符号索引 |
| `repo_map` | 分页读取所有已核算的 Git 跟踪文件 |
| `repo_read` | 读取不可变分块或指定行范围 |
| `repo_search` | 搜索原始仓库文本，返回精确文件和行号 |
| `repo_symbols` | 构建或搜索 AST 定义与引用 |
| `repo_context` | 组合原文搜索、AST 符号和新鲜的 CodeGraph 上下文 |
| `repo_compare` | 不切换工作区即可比较提交或分支 |
| `repo_scan` | 开始、继续、确认和恢复完整扫描 |
| `repo_coverage` | 报告文件、行、分块、传递和失败覆盖率 |

其他工具族还提供有边界的文件访问、项目打包、Git diff、Skill、handoff、
Codex Runner 任务、测试、trace 和本地诊断。完整生成目录见
[`assets/mcp-tools.json`](./assets/mcp-tools.json)。

## 工具档位

| 档位 | 用途 |
| --- | --- |
| `readonly` | 推荐的公网仓库分析档位 |
| `minimal` / `chatgpt-app` | 兼容旧版有边界的应用与写入流程 |
| `standard` / `normal` | 项目、Git、测试、Skill、trace 和 Codex 任务 |
| `full` / `debug` | 可信本地调试，开放底层文件、进程和 shell 工具 |
| `codex-runner-only` | 只提供高级 Codex 任务控制，不开放通用项目工具 |

`setup` 默认选择 `readonly`。除非明确需要本地写入和命令执行，否则不要在
公网连接器上启用 `standard` 或 `full`。

## 安全模型

- 策略缺失、格式错误或校验失败时，服务拒绝启动。
- 所有路径都进行规范解析，并且必须位于授权根目录内。
- 拒绝路径穿越、已有符号链接逃逸和悬空符号链接逃逸。
- deny glob 同时应用于读取、列表、搜索、清单、符号和扫描。
- HTTP 只监听 `127.0.0.1`；Tunnel 是单独、显式的公网边界。
- 浏览器 CORS 只允许配置的 Origin。
- Shell 默认关闭。
- 默认 OAuth scope 为 `workspace:read`。
- 运行密钥保存在 Git 忽略的 `.env.local` 中，并采用仅所有者可读写权限。

扩大根目录或启用写入前，请检查
[`bridge.policy.example.json`](./bridge.policy.example.json) 和
[安全模型](./docs/security.md)。

## CLI

| 命令 | 用途 |
| --- | --- |
| `setup --root <path>` | 创建 fail-closed 配置和本地密钥 |
| `start` | 在前台运行 OAuth/MCP HTTP 服务 |
| `doctor [--json]` | 检查配置、依赖、根目录与服务健康状态 |
| `status [--json]` | 显示本地配置与服务状态 |
| `index [--root <path>] [--json]` | 构建 Git 清单、AST 符号并同步 CodeGraph |
| `install-service` | 安装并启动 macOS launchd 服务 |
| `install-tunnel --hostname <host>` | 创建固定 Cloudflare Tunnel 和 launchd 服务 |
| `stop` / `restart` | 控制已安装的 Bridge 服务 |

当前命令合同以 `node dist/index.js help` 为准。

## macOS 应用

```bash
npm run macos:app
open build/macos/ChatGPT2LocalBridge.app
```

安装到 `/Applications`：

```bash
npm run macos:install
```

应用包内置 Node、非系统动态库、生产依赖，以及 CLI 使用的同一套 TypeScript
引擎。它提供本地控制台，用于查看服务状态、策略、日志、工具活动和连接器操作。

## 开发

```bash
npm ci
npm run typecheck
npm test
npm run tools:catalog
npm pack --dry-run
```

使用 `npm run macos:app` 构建 macOS 应用。完整测试覆盖 MCP 档位、OAuth
元数据、CORS、策略失败、拒绝路径、符号链接逃逸、CLI 初始化、分支隔离、
UTF-8 分块、符号索引和可恢复扫描。

## 文档

- [架构](./docs/architecture.md)
- [大型仓库工作流](./docs/large-repositories.md)
- [运行维护](./docs/operations.md)
- [安全模型](./docs/security.md)
- [身份验证模式](./docs/authentication-modes.md)
- [Linux 部署](./docs/linux-deploy.md)
- [统一运行时与覆盖率 ADR](./docs/decisions/001-canonical-runtime-and-repository-coverage.md)
- [路线图](./ROADMAP.md)

## 限制与非目标

- 本项目不会自动化或抓取 ChatGPT 网页；它使用 MCP 和 ChatGPT 自定义连接器。
- 本项目不会自动上传整个仓库。只有授权客户端请求工具时，相应内容才会出现在
  工具响应中并离开本机。
- 扫描证明的是可核算的传递过程，不代表模型永久记住了所有代码。大型系统仍需
  分块总结和任务相关检索。
- AST 符号目前覆盖 TypeScript、JavaScript 和 Python；其他文本文件仍可搜索
  和分块读取。
- CodeGraph 绑定具体 worktree；同时维护多个分支索引时应使用独立 worktree。

## 上游与许可证

- 原项目及原作者：
  [`Harzva/chatgpt2localbridge`](https://github.com/Harzva/chatgpt2localbridge)
- 增强版 fork：
  [`ZhWang1104/chatgpt2localbridge`](https://github.com/ZhWang1104/chatgpt2localbridge)
- 许可证：[MIT](./LICENSE)

贡献代码时应继续保留上游署名，并确保默认公网工具面保持收敛、只读和可审计。
