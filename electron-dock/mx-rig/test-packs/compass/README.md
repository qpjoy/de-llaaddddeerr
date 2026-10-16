# 罗盘 Compass 验收包

Rig 用这个目录在工作台里「从验收包创建」罗盘测试项目（docs/21 §5）。这里是种子：
创建时复制进项目自己的 QA Git 仓库，之后以项目 QA 仓库为准。

## 内容

| 路径 | 是什么 |
| --- | --- |
| `pack.json` | 项目定义：被测源码（仓库、分支、固定提交、子目录）、执行方式、执行计划、用例目录 |
| `rig-specs/` | Web 用例（`web/*.spec.mjs`）和运行脚本 `run.mjs` |
| `rig-specs/electron/` | 桌面端 Playwright Electron 测试包（原 `test-packs/compass-electron`） |
| `reference/public-48af490/` | 旧 Cypress 用例（`public@48af490`，23 条）的目录：只作参考，不执行，不计入分母 |

## Web 用例怎么跑

对**源码快照**运行，不碰开发者自己的检出：

1. 桌面端把 `feat/yjj/hdo_v2@a4cc5de` 拉成 Rig 自己的只读快照（不在原仓库里切分支、写文件）。
2. `run.mjs` 核对快照就是固定的提交、源码没有被改；
3. 用本机 pnpm 缓存安装依赖（不执行安装脚本），把前端构建成 Web 版，接口地址指向不可解析的 `compass-api.rig.invalid`；
4. 每条用例在独立的浏览器里运行并录像。页面的每个接口请求都由这条用例的假后端应答，其他外部请求一律拦截并记在日志里。

所以**结果只说明「这个提交的前端在这些数据下的行为」**，不等于线上通过。

运行条件：持有快照的电脑上有 Node.js 22 和 pnpm。本地调试：

```bash
RIG_SOURCE_DIR=/path/to/snapshot RIG_PROJECT_FILE=../.rig/project.json node run.mjs
```

`RIG_HEADED=1` 显示浏览器；`MXT_CASE_FILTER=CPS-WEB-AUTH-001,web/chat.spec.mjs` 只跑部分用例。

## 第一批用例（hdo_v2）

| 编号 | 内容 |
| --- | --- |
| CPS-WEB-AUTH-001～003 | 未登录进入登录页；账号密码加滑块登录进入首页；密码错误的提示 |
| CPS-WEB-HOME-001～003 | 提问入口与地区舆情榜；热点详情；历史对话进入 AI 对话 |
| CPS-WEB-CHAT-001～002 | 流式回答完整显示；分析服务出错的提示 |
| CPS-WEB-STRAT-001～003 | 策略列表；按关键词查找；平台列表接口失败时策略列表仍应加载（**在 a4cc5de 上失败**，是产品问题，见下） |

**已发现的问题**：`Strategy.vue` 进入页面时依次等待平台列表、配额、策略列表；平台列表接口一旦失败，后面的策略列表不再加载，页面显示“暂无策略数据”。

## 桌面端

`rig-specs/electron` 的两条启动冒烟依赖的选择器（`#account`、`#password`、`.login-button`、`.ai-home-page`、`startup-loading.html`）在 hdo_v2 源码里仍然存在。但罗盘启动会初始化 Launcher、代理或隧道，只能在专用测试机上运行（见该目录 README）。正式登录依赖评审过的非生产验证码钩子和专用测试账号，没有就保持受阻。
