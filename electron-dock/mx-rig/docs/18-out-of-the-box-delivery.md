# 开箱即用：本机一键体验、自带测试浏览器、写好服务器地址的安装包

日期：2026-10-02。代码基线：0.8.0 Preview（`feat/mx_insight_hub`）。

## 0. 结论

以前要用起来，得先做这些事：
- 跑 `npm run dev`，再去 `.runtime/dev-token` 找密码；
- 手动安装 Chromium（`npm run browser:install`，国内经常下载失败）；
- 打包出来的安装包不带浏览器，登录页每次都要手输服务器地址。

还有一点直到这次才发现：**在 Mac 上打出来的安装包根本打不开**，原因见 §6。

现在：

| 谁 | 做什么 |
| --- | --- |
| 开发、运维在本机体验 | `bash scripts/manage.sh local init`。不知道的配置自动生成，需要人填的才问；装依赖、准备测试浏览器、后台启动服务，一条命令做完。macOS、Linux、Windows 的 Git Bash 都支持 |
| 给同事打安装包 | `bash scripts/manage.sh desktop --server <服务器地址>`。安装包里带着 Chromium，登录页已经填好服务器地址 |
| 测试、产品同事 | 装上，打开，用管理员发的账号登录。Mac 上第一次打开时，按安装包里的说明多点一步 |

## 1. 本机一键体验（`scripts/local.mjs`）

```bash
bash scripts/manage.sh local init
```

`init` 依次做这些事：
1. 检查 Node.js 版本（至少 22）；
2. `npm install`，失败时改用 npmmirror 下载 Electron 再试一次；
3. 生成或询问配置；
4. 准备测试浏览器；
5. 同步设计资源；
6. 后台启动服务，打印访问地址。

| 配置 | 怎么来 |
| --- | --- |
| 管理员密码、服务密钥 | 自动生成，不打印；用 `local token` 查看 |
| 端口 | 问。默认 8791，被占用时自动往后找空闲端口 |
| 局域网访问 | 问，默认否。选是就监听 0.0.0.0，并用本机的局域网地址作为访问地址 |
| PostgreSQL | 问，默认留空，即内存模式（重启服务后，测试中心的应用、计划和成员会清空；任务记录和配置会保留） |
| 模型 | 依次问接口地址、模型名、API Key，API Key 输入时不显示。启动后会自动写进服务的 Provider 设置；不填也能启动，只是 Agent 任务会显示「受阻」 |

- **再次运行 `init`**：每一项都以上次的答案为默认值，直接回车就保留。
- **事先给值**：环境变量里已有的值不会再问，所以下面这样一个字都不用敲：
  ```bash
  MX_RIG_MODEL_API_KEY=… MX_RIG_LOCAL_MODEL_BASE_URL=https://…/v1 MX_RIG_LOCAL_MODEL_NAME=… bash scripts/manage.sh local init --yes
  ```

其他命令：

| 命令 | 作用 |
| --- | --- |
| `local up` | 后台启动服务；已经在运行就只打印地址；没初始化过就先初始化 |
| `local desktop` | 打开桌面端，登录页已经填好本机服务地址 |
| `local status` | 服务、模型、浏览器测试、测试浏览器、存储方式 |
| `local logs [-f]` | 服务日志 |
| `local token` | 管理员密码（账号 admin） |
| `local down` | 停止服务 |
| `local reset` | 停止服务，清空本机的任务、配置和测试数据；`local.env` 保留 |

所有文件都在 `.runtime/local/` 下：
- `local.env`：答案，权限 0600；
- `server.log`、`server.pid`；
- `control/`、`artifacts/`：服务的数据。

它不改系统设置，不占别的产品的端口，不碰 MX-H2I。

**跨平台的做法**：
- `manage.sh local` 只是把命令转给 `scripts/local.mjs`，三个平台走同一份 Node 实现。npm 在 Windows 上通过 shell 调用 `npm.cmd`。后台进程、进程检查、停止都只用 Node 自带的接口。
- **Git Bash 的两处处理**：
  - Windows 版 Node 不认 `/c/...` 这样的路径，脚本路径先用 `cygpath -w` 转成 Windows 路径；
  - mintty 给不了 Node 真正的终端，这时如果有 `winpty` 就套一层，API Key 才能隐藏输入。没有 `winpty` 时照样能用，只是会先提示「输入的内容会显示出来」。
- `.gitattributes` 规定 `*.sh` 一律 LF，Windows 上检出的脚本不会因为 CRLF 跑不起来。

## 2. 测试浏览器从哪里来（`packages/runtime/browser-provision.mjs`）

**按顺序找，用第一个存在的**：
1. `MX_RIG_CHROMIUM_PATH` 指定的可执行文件；
2. 安装包自带的那份（`resources/ms-playwright`）；
3. Playwright 的缓存，包括 `PLAYWRIGHT_BROWSERS_PATH`，也就是开发机上 `npm run browser:install` 装的那份；
4. 以前下载过的那份：桌面端在应用数据目录的 `browsers/`，终端和工位在 `~/.mx-rig/browsers/`；
5. 电脑上已经装好的 Google Chrome 或 Microsoft Edge。

**都没有时**，下载与 Playwright 版本对应的 Chrome for Testing：
- 先从 Playwright 的 CDN 下载。它会跳转到 `storage.googleapis.com`，国内经常连不上，失败了就换 npmmirror 的同一份文件。
- 下载、解压、写完成标记，用的都是 Playwright 自己的下载进程。
- 同一时间只下载一次，两个浏览器步骤同时要用时，等的是同一次下载。

**进度显示在**：
- 桌面端：标题栏下面一行「正在准备测试浏览器 … 45%」；失败时显示原因和「重试下载」。
- 终端：一行灰字。
- 工位：日志。

桌面端登录后，如果这台电脑上什么浏览器都没有，会立刻在后台开始下载，不等第一个任务。

`npm run browser:install` 也改用同一套下载逻辑，国内同样能装上。

| 环境变量 | 作用 |
| --- | --- |
| `MX_RIG_BROWSER_MIRROR` | 换成你们自己的镜像（可以逗号分隔多个），目录结构同 chrome-for-testing |
| `MX_RIG_BROWSER_MIRROR_ONLY=1` | 只用 npmmirror |
| `MX_RIG_CHROMIUM_PATH` | 直接指定一个可执行文件 |

**实测**：在这台机器的网络下，只走 npmmirror 下载 170 MB 用了 29 分钟。所以安装包默认自带浏览器，下载只是兜底。

## 3. 给同事打安装包（`scripts/package.mjs`）

```bash
bash scripts/manage.sh desktop --server http://10.0.0.5:8791 --private-http
```

| 选项 | 作用 |
| --- | --- |
| `--server <地址>` | 登录页一开始填的服务器地址。不写时，如果这台机器用 compose 起过服务，就用那个服务的地址 |
| `--private-http` | 登录页一开始就勾上「内网测试服务器」（私有 IP 上的明文 HTTP） |
| `--no-browser` | 不带 Chromium。安装包会小 170 MB 左右；第一次用时下载，或者用电脑上的 Chrome / Edge |
| `--dir` | 只生成应用目录，不生成安装包 |
| `--win` / `--linux` / `--x64` | 打别的平台或架构的包，会单独下载那个平台的 Chromium 带进去。不过 macOS 的包要在 Mac 上打，Windows 的包要在 Windows 上打 |

**打包时做的事**：
- 服务器地址只写进这一次打出来的包。打完就删掉，从源码运行的桌面端不受影响。
- 带上 Chromium：这台机器缓存里有对应版本就直接用；没有就下载一次，放在 `.runtime/browsers/<平台>`。
- **Mac 上没有 Developer ID 时，对整个应用做 ad-hoc 签名**。不签的话，Electron 原有的签名在重新打包后失效，Apple 芯片会直接杀掉子进程（日志里是「Network service crashed」）。签了也还是没有公证，Gatekeeper 第一次打开时仍会拦一次。有证书时（设置了 `CSC_LINK` 或 `CSC_NAME`）照常用证书签名。
- DMG 里多一个「首次打开说明.txt」。

**登录页的地址**：优先用这台电脑上次登录成功的地址（保存在应用数据目录的 `login.json`，只存地址和账号，不存密码），其次用安装包写好的地址，最后用 `http://127.0.0.1:8791`。

实测：Apple 芯片的 DMG 262 MB，应用里的 Chromium 解压后 358 MB。

**Launcher 独立端**（docs/25）：

```bash
bash scripts/manage.sh desktop --launcher
```

- 打出来的应用是 Launcher 的独立产品 `mx-rig`：经自己的产品网络连 Rig 服务（VIP），登录用平台统一账号，没有服务地址要填。
- 安装包带上目标平台的 WireGuard 引擎，以及海外通道用的 Mihomo 引擎（docs/25 §9，压缩后约 16 MB，第一次使用时解压）；`--bootstrap <地址,地址>` 可以改入口，默认先走公网中继 IP，再走 `h2i.minsight-ai.com`。
- 第一次要先在 Launcher 那边登记：在 Internal 节点上运行 `scripts/manage.sh launcher plan` 看计划，`launcher apply` 写入（需要 `MX_LAUNCHER_OPS_TOKEN`），剩下两步按提示在 Launcher Admin 里做。`apply` 同时开通两个发版账号，凭据只存进 Secret `mx-rig/mx-rig-release`。
- 安装包叫 `MX-Rig-<版本>-<mac|win>-<架构>.<dmg|exe>`，旁边有一个同名的 `.json` 发布清单（版本、平台、架构、大小、SHA-256）。
- 装好的 Launcher 独立端会自己更新（docs/25 §8）：新版本经 Release Center 发布，先发给指定的安装 ID，验证后再推给所有人。把安装包和 `.json` 拷到 Internal 节点上：

  ```bash
  scripts/manage.sh release publish MX-Rig-0.9.0-mac-arm64.dmg --install-id <安装 ID> --notes notes.md
  scripts/manage.sh release approve <plan> --smoke passed   # 在测试机上亲手装过之后
  scripts/manage.sh release promote <plan>                  # 定向更新走通之后，再 approve 一次
  ```

  安装 ID 在桌面端点「检查更新」后显示。macOS 和 Windows 的包各发一次；只有 `--launcher` 打的包能发布。
- 浏览器统一认证（docs/25 §11）：在 Launcher Internal 的「统一认证 → 接入应用」登记 `mx-rig` 之后，再运行一次 `scripts/manage.sh deploy`，它会自动带上档案，日志里出现 `browser SSO: on`。网页端在 `https://rig.minsight-ai.com` 用统一认证或飞书登录；桌面端用系统浏览器登录。域名和网关的要求见 [deploy/gateway/README.md](../deploy/gateway/README.md)。

**开发用本地包，打包用发布的包**（参考 MX-H2I 的 `setup` / `setup:npm`）：

Rig 运行时用到 Launcher 仓库里的两个包：`@qpjoy/electron-launcher`（网络、更新）和 `@qpjoy/electron-core-mihomo`（海外通道）。

| 命令 | 作用 |
| --- | --- |
| `npm run setup` | 开发：先构建本仓库里的这两个包（需要 pnpm），再让 mx-rig 用它们。改了 Launcher 的代码，`npm run desktop` 就能直接试 |
| `npm run setup:npm` | 切回 `package-lock.json` 锁定的已发布版本，并核对版本是否一致 |
| `npm run dev-mode` | 显示现在用的是哪一份，以及锁定版本和仓库版本 |

- 切换只改 `node_modules` 指向哪里：本地模式是链接，npm 的那份放在一边，切回来时直接还原，不用重新下载。`package.json` 和 `package-lock.json` 不会变，所以提交的永远是发布配置。
- 打包时不用手动切：`npm run package` 和 `manage.sh desktop` 会自己切到已发布的包，打完再切回本地模式。安装包永远只用发布过的版本。
- 仓库里的 Launcher 包比锁定版本新时，打包会提醒：新代码不会进安装包，要先发布，再更新 `package.json`。

**两个平台的安装包**：

| 命令 | 产物 |
| --- | --- |
| `bash scripts/manage.sh desktop --launcher --mac --all`（等同 `npm run make:mac`） | `MX-Rig-<版本>-mac-arm64.dmg`、`…-mac-x64.dmg`、`…-mac-universal.dmg` |
| `--mac --arm64`、`--mac --x64`、`--mac --universal` | 只出其中一个，也可以任意组合 |
| `bash scripts/manage.sh desktop --launcher --win`（等同 `npm run make:win`，必须在 Windows 上） | `MX-Rig-<版本>-win-x64.exe` |

- **universal 包**：一个 DMG 两种芯片都能装。里面带两份 Chromium 和两套网络引擎，所以大约是单架构包的两倍，运行时各取自己架构的那份。
- **x64 包**：在 Apple 芯片的 Mac 上也能打，第一次会下载 x64 的 Chromium 和引擎，存在 `.runtime/` 里。官方 CDN 不通时（2026-10-17 在这台机器上就是这样），加 `MX_RIG_BROWSER_MIRROR_ONLY=1` 直接走 npmmirror。
- **Windows 安装程序**：和 MX-H2I 一样，安装时可以选择目录，按用户安装，不需要管理员权限；第一次连接内网时才会弹 UAC。
- **Windows 打包机**：要克隆整个仓库（打包依赖同级的 `mx-common` 和 `mx-launcher/ui-design`），然后先运行 `node electron-dock/mx-launcher/ui-design/scripts/build.mjs`，再在 mx-rig 里 `npm install`。

**发版时顺手录演示录像**（docs/24 M8c）：「新手引导」里每个关卡都有一段录像，发版时重录，所以录像里就是这一版的界面。

```bash
npm run record:tours
```

```bash
MX_RIG_URL=https://rig.example MX_RIG_ADMIN_TOKEN=… npm run record:tours -- --publish-only
```

- 第一条：起一个临时服务和一个干净的桌面端，用「演示」速度依次走完每个关卡并录屏，再剪成每个关卡一段。结果写到 `.runtime/tours/`，大约 3 分钟。
- 第二条：把录好的上传到团队的服务器。只有管理员能发布；同一个关卡只保留最新一段。
- 一步完成就用 `-- --publish`，录完直接上传。
- 录像里只有替身数据：一个替身 po-frontend 仓库、内置试验场、一台叫「演示电脑」的执行机。临时目录不在任何人的主目录下，所以录像里没有个人路径和主机名。
- 需要 Playwright 带的 ffmpeg（`npx playwright install ffmpeg`），或者用 `MX_RIG_FFMPEG` 指定。
- 「新项目」录完后，脚本会真跑一次它停下的那次执行，好让「读懂一次执行」有真实结果可读。这一步要在本机装测试依赖，需要能访问 npm 源。

## 4. 同事第一次打开

**macOS**：
1. 把 MX Rig 拖进「应用程序」。
2. 右键 →「打开」。macOS 15 以上没有这个选项时：先双击一次，再到「系统设置 → 隐私与安全性」点「仍要打开」。
3. 如果 MX Rig 是从磁盘映像或「下载」文件夹里直接打开的（macOS 会给它一个临时的只读副本），会先弹出一个说明框：「把 MX Rig 放进『应用程序』」。点了之后：
   1. 先以当前用户的身份复制，并去掉隔离标记；
   2. 当前用户没有权限时（比如已有一份别人装的），才弹出系统密码框（`do shell script … with administrator privileges`）。复制完把所有权交还给当前用户；
   3. 从「应用程序」里重新启动。

   这和 MX-H2I 请求权限的方式一样：先说明为什么，再交给系统自己的对话框。
4. 已经在「应用程序」里、只是还带着隔离标记时，直接去掉标记，不打扰人。

**Windows**：
- 安装包没有签名，SmartScreen 会拦一次：点「更多信息 → 仍要运行」。
- 安装到当前用户目录下，不需要管理员权限，也不会弹 UAC。

**Linux**：AppImage 需要先加执行权限：
```bash
chmod +x MX*.AppImage
```

**测原生应用（macOS）**：
- 点「检查辅助功能权限」，系统会弹出授权框。
- 如果没有授权成功，按钮下面会出现「打开『辅助功能』设置」和「打开『自动化』设置」，直接跳到对应的设置页。

## 5. 安全边界

- `login.json` 只存地址、是否内网 HTTP、账号；密码不落盘。
- `open-privacy` 只能打开两个固定的设置页，界面传不了任意地址。
- 第一次打开时执行的命令只涉及 MX Rig 自己的应用目录：
  - 所有路径都用 shell 单引号转义；
  - 有测试覆盖带单引号的路径；
  - 需要管理员权限时，执行完会把应用目录的所有权交还给当前用户。
- 本机体验的 `local.env` 含管理员密码和模型密钥，权限 0600，不打印密码。

## 6. 这一轮修掉的打包问题

Mac 上的安装包以前从来没有真正运行过（冒烟测试的 `--packaged` 只覆盖 Windows）。实际打开时有三个问题：

| 问题 | 现象 | 修复 |
| --- | --- | --- |
| 签名失效 | 应用一启动就退出，日志里是「Network service crashed」 | 没有证书时 ad-hoc 签名（§3） |
| 启动时往 app.asar 里写设计资源 | 弹窗「MX Rig 启动失败：ENOTDIR … app.asar/apps/web/vendor/」 | 打包后的应用不再同步，安装包里已经带着这份资源 |
| 安装包里 `playwright-core` 在 `playwright/node_modules` 下（这一轮新代码引入的） | 登录失败：「执行失败；请检查服务连接…」 | 通过 `playwright` 自己的位置解析 |

## 7. 验证

- `tests/browser-provision.test.mjs`：
  - 版本和平台对照、下载地址顺序、镜像列表；
  - 安装包自带的优先，其次是指定的可执行文件；
  - 本地服务器扮演镜像：第一个镜像 404 后换下一个，下载、解压、写完成标记，已经有了就不再下载，下载失败说明是哪个地址；
  - 在独立进程里模拟一台什么都没有的电脑：第一个浏览器步骤会等下载完成，两个步骤同时要用只下载一次。
- `tests/first-run.test.mjs`：
  - 从临时副本、「下载」文件夹、「应用程序」、本机构建目录打开时分别怎么做；
  - 命令里的路径转义（带单引号的路径交给真实的 sh 验证）；
  - AppleScript 字符串转义。
  - 不运行 osascript，不碰「应用程序」文件夹。
- `tests/local-script.test.mjs`（隔离的数据目录）：
  - 按行输入的答案都落到正确的位置，`local.env` 权限 0600，生成的密码不打印；
  - 再次 `init --yes` 保留原值；
  - `up` 后服务在线、模型已经写进设置，重复 `up` 只启动一次；`status`、`token`、`down` 都正常；
  - 非法端口被拒绝；
  - `manage.sh local` 转给同一个脚本。
- `npm run test:desktop -- --browser` 新增：
  - 登录页一打开就是安装包写好的地址；
  - 测试浏览器无需安装即可用；
  - 退出后 `login.json` 里有地址和账号，没有密码。
- **安装包实测（Apple 芯片）**：
  - `--dir` 和 DMG 都打出来了；签名校验通过；DMG 里有「首次打开说明.txt」；
  - 用 Playwright 启动打包后的应用：登录页是写好的地址，并勾选了「内网测试服务器」；
  - 登录后使用的是「安装包自带的测试浏览器」，自带的 Chromium 145 能启动，页面零报错。
- **实际下载**：只走 npmmirror，下载、解压、启动 Chromium 145 全部成功（29 分钟）。

## 8. 限制

- **没有实测的环境**：Linux 和 Windows 的 Git Bash 都没跑过，只按各自的规则写了处理（`npm.cmd`、`cygpath`、`winpty`、LF）；Windows 的安装包也要在 Windows 上打、上面测。
- **第一次打开的隔离处理没有走过一遍真实流程**：需要从浏览器下载 DMG 才会带上隔离标记。单元测试覆盖了判断逻辑和要执行的命令。
- **签名**：ad-hoc 签名只能让应用运行，Gatekeeper 第一次仍会拦。要做到双击直接打开，需要 Apple Developer ID 签名加公证（每年 99 美元，见 MX-H2I 的 docs/03 和 docs/19）。Windows 要消除 SmartScreen 也需要代码签名证书。
- **体积**：安装包自带浏览器后大约 260 MB。要小的话用 `--no-browser`，代价是第一次用时要下载。
- **内存模式**：本机体验默认是内存模式，重启服务后测试中心的数据会清空；要保留就在 `init` 时填 PostgreSQL 连接串。
- **Linux arm64**：Chrome for Testing 没有这个平台的构建，只能用系统自带的 Chromium 或 Chrome（`MX_RIG_CHROMIUM_PATH`）。
