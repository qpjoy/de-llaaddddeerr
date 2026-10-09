# Mobile-Agent / PoC：来源、端口与复用边界

核实日期：2026-10-10。证据分为：**S** 用户回传的服务器状态；**L** 本机导出源码/文档；**W** 公开官方资料；**P** 本项目方案。S 不是本次重新远程执行的结果；L 尚未与正在运行的镜像逐文件比对。

## 1. 先回答端口与实例问题

用户给出的 `docker ps` 是**一个容器发布多个端口**，不是四个容器，也不能仅凭端口推算进程或项目实例数量：

| 位置/端口                               | 实际职责                                                        | 证据与置信边界                                                                                                                      |
| --------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 宿主机 8765 → 容器 8765                 | `ip_rights_module/server.mjs`，侵权处置业务 Web 子服务          | S：页面标题 IP RIGHTS · MODULE，抖音/拼多多处置；L：`start_ip_rights_sidecar()` 探测 8765 `/health`，未运行时启动 `node server.mjs` |
| 宿主机 8787 → 容器 8787                 | `web_server.py` HTTP 控制台，含设备、截图、动作、任务及业务数据 | L：`parse_args()` 默认 8787，README 自称“侵权中台”，不是只有裸手机控制能力                                                          |
| 宿主机 8788 → 容器 8788                 | WebSocket H.264 屏幕通道 `/ws/video?device=...`                 | L：`main()` 单独启动视频服务器；不是另一个 AI Agent 实例                                                                            |
| 宿主机 **127.0.0.1:18081 → 容器 18082** | 旧手机 PoC API 对外转接入口                                     | S：Docker 映射；不是 8787 控制台的另一份实例                                                                                        |
| 容器 18081 → 手机 18081                 | ADB forward，对应 `8ad5ef10` 的 PoC HTTP 服务                   | S：`host:list-forward` 返回 `8ad5ef10 tcp:18081 tcp:18081`，容器内与宿主机 `/api/state` 一致                                        |
| 手机 `com.example.xhspoc`               | 旧 PoC 控制 App，另含 MitmVpnService                            | S：Android services；L：《使用文档》说明 API、补丁初始化及结果回传                                                                  |

当前可重建的通道为：**宿主机 18081 → 容器 18082 转接 → 容器 18081 ADB forward → 手机 18081 PoC**。前后映射有证据；**18082 转接程序究竟是 socat、其他代理还是自定义入口脚本，目前缺原 Compose/Dockerfile/entrypoint 代码，不能编造具体实现**。

8765 与 8787 在同一部署里组合，不等于同一个服务。源码明确把 8765 称为 sidecar，以子进程方式启动并可独立存活；此处不是指 Kubernetes sidecar 容器。截图与源码吻合，但当时 8765 进程究竟由本次主程序启动还是已提前运行，仍需进程证据。

因此，“mx-device 只适配 mobile-agent”应具体为：**选择 8787 中最小的设备能力，不依赖 8765 侵权业务，不复制旧业务调度器；18081 留作可选取数适配器。** 8788 也不是必须接入，当前 PNG 就可以展示真实手机。

## 2. 手机 PoC / VPN 是否是基础依赖

用户提供的 `/tmp/使用文档.md` 标题是《XHS PoC 使用文档》，日期 2026-09-02，适配 `com.example.xhspoc` + 小红书 9.45.0。它描述：

- PoC 手机 App 提供 18081 控制 API，VPN 用于初始化补丁；XHS 内的 Robust 补丁执行搜索/翻页/详情并回传 JSON。
- `/api/search`、`/api/next`、`/api/note` 是同步 GET，但**有执行副作用**，并非只读；一次最长等待 25 秒，全局只容纳一个在途任务。
- `/api/next` 依赖前一搜索的全局上下文；没有在已知协议中看到 taskId、执行幂等键、按任务取消确认或跨机游标恢复。
- 原文称初始化完成后的取数不依赖 VPN。这只是文档描述，**不是现场安全关闭 VPN 的证明或授权**。当前 VPN 正在运行，不应擅自关闭或 force-stop PoC。

通用截图/点击/应用导航走 ADB 或其他设备控制协议，不需要以这套 VPN/补丁作为基础。现有结构化取数却不能仅用截图等价替代：UI 可见内容、OCR/层级提取、业务 API JSON 的字段范围、精度和来源都不同。移除依赖的顺序应是“新增替代能力并验收 → 明确切换调用方 → 保留回退”，不是先杀掉 PoC。

本轮没有导出或审阅 PoC APK 源码，不知道作者、授权、完整运行状态机或 busy 恢复接口；不能承诺直接移植补丁或一键复位。

## 3. Busy 排查时间线：已知什么，不知道什么

| 用户已回传的观察                                                                                    | 能支持的结论                                                 | 不能据此推断                                                   |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------- |
| Docker running、restarts=0；宿主机/容器 `/api/state` HTTP 200                                       | 容器和部分 HTTP 通路能响应                                   | 手机任务完成、物理执行空闲                                     |
| 长期 `status=正在加载第 2 页…`、page=1、count=16、hasMore=false、isBusy=true                        | 上游保存了一页结果并报告忙；加载文字和已报告页码属于不同字段 | 第二页已完成；false 必然表示真实结果已耗尽；busy 必然是锁屏    |
| ADB serial 状态 device                                                                              | 当时 ADB transport 可用                                      | App 内逻辑正常、没有其他调用方                                 |
| Awake / Powered / Display ON / keyguard showing=false、secure=false                                 | 当时亮屏且未锁屏                                             | 始终不会息屏，或先前从未锁屏                                   |
| 最初前台 `com.example.xhspoc/.MainActivity`                                                         | PoC 当时在前台                                               | VPN 就是 busy 原因                                             |
| 通用 MAIN/LAUNCHER 启动失败，显式 `com.xingin.xhs/.index.v2.IndexActivityV2` 成功；随后前台为小红书 | 应用存在且显式 Activity 能启动                               | 已恢复搜索回调或清除 busy                                      |
| MitmVpnService 运行且由 Android 绑定                                                                | PoC 承担 VPN 服务                                            | 可以安全重启其进程；`vpn_management` 查询失败不等于 VPN 不存在 |
| 实际截图是小红书“发现”首页，PoC 仍报告美食第 1 页                                                   | 缓存业务状态与当前物理屏幕可能不同                           | 必须选其中一个覆盖另一份证据                                   |

**当前诊断：PoC 的任务/回调状态可能卡住或陈旧，但尚未定位根因。** 不将“可能”写为已修复，不要继续靠反复启动 App 或忽略 busy 验收。截图可独立读取；UI 动作在技术上未必检查该 busy，但仍可能与 PoC 或旧 runner 并发，不能当作安全绕过开关。

## 4. 服务器与设备档案（历史快照）

- 宿主机：`mx-internal-server`；用户通过 `10.88.88.88:8765` 访问业务页面。
- 容器：`mobile-agent`，ID `2722b10e2e5a`；镜像 `mobile-agent:latest`。
- 镜像 ID：`sha256:ca24a84d4e3093fbe80c732ae4580c6ffecc693923ea9a5c9b2968ca62ac532d`。
- 曾报告启动时间 `2026-09-20T10:16:18.822101736Z`、restarts=0。日期只表示那次 inspect 结果，不是当前健康证明。
- 工作目录 `/app`；Compose 目录 `/home/gjx/Mobile-Agent`；文件 `/home/gjx/Mobile-Agent/docker-compose.yml`。
- 宿主机与容器均未找到 `.git`，有 `.gitignore`；未取得 Git remote。设置 `GIT_DISCOVERY_ACROSS_FILESYSTEM` 不会为一个源码拷贝补出 Git 历史。
- 手机：serial `8ad5ef10`，model `2112123AC`，product/device `psyche`；USB `1-2`、transport_id=3 是当时连接信息，不是长期身份。
- 小红书：包 `com.xingin.xhs`，versionName `9.45.0`，versionCode `9450805`；已解析 Activity `.index.v2.IndexActivityV2`。这是应用版本，不是手机 Android 系统版本。

已知挂载包括 `AI-JuBao`、`data`、`ip_rights_module/data`、`scripts/runs`、`known_faces`、`reports`、`screenshots`，以及 `/dev/bus/usb`、`/home/gjx/.android`、`/home/gjx/.claude`、项目 `.env`、`config.json`。**这些目录含运行数据、身份或密钥，不能为了找 Git 来源整包上传。** 截图/代码导出也要检查硬编码秘密。

## 5. 本机证据目录（不是服务器路径）

本次确认以下路径存在，位于 macOS `/tmp`（可能解析到 `/private/tmp`）：

| 本机绝对路径                                                          | 内容 / 用途                                                                          |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `/tmp/mobile-agent/mobile-agent-review.Tc1Yq5/`                       | 第一批导出；README.md、ARCHITECTURE.md、web_server.py、requirements.txt、同名 tar.gz |
| `/tmp/mobile-agent/mobile-agent-core.nweAZc/mobile-agent-core.tar.gz` | 第二批 core 导出，只有选定文件，不是完整项目                                         |
| `/tmp/mx-device-core-review.vGw1Fa/`                                  | 第二批已解压供审阅的文件，见下面清单                                                 |
| `/tmp/mobile-agent/mx-device-screen.eTI1P6/phone.png`                 | 用户导出的实际手机屏幕，不是模拟投影                                                 |
| `/tmp/使用文档.md`                                                    | 上述 XHS PoC 文档；本次只作接口与角色证据，不执行其中安装/恢复命令                   |

第二批解压文件：

```text
core/device_manager/adb_controller.py
core/device_manager/device_registry.py
core/task_engine/scheduler.py
core/task_engine/schedule_runner.py
core/task_engine/task_queue.py
core/task_engine/task_runner.py
core/storage/database.py
scripts/nurture/agent.py
```

两份导出包 SHA-256（校验的是导出包，不是正在运行的镜像源码）：

```text
mobile-agent-review.tar.gz
22d10aff060571fc47a87f25fa8030f2c0747c62204a57c79481370dd3036d24

mobile-agent-core.tar.gz
f954b26d6cf601396ae1a6a7c09c2a177c3385f6e6bc3c74e9cea25c8053c319
```

其他会话产物定位线索：

- 历史日志附件 `/Users/qpjoy/.codex/attachments/ce5abc2b-7313-4170-8783-af430640bc67/pasted-text.txt`，早期 ADB 附件 `/Users/qpjoy/.codex/attachments/16e7078e-d8e6-402b-a1bc-6647ed069a15/pasted-text.txt`；未在本次重新全文读取，应先脱敏。
- 8765 页面截图 `/var/folders/n2/kk2sxv7103z_fj_mmyp2rllc0000gn/T/codex-clipboard-56d4bd5b-1ee5-4785-bc2c-0a504e0f8079.png`。
- 前阶段本地假接口 QA 脚本曾保存在 `/tmp/mx-device-adapter-qa.mjs`、`/tmp/mx-device-status-qa.mjs`；只是临时调试产物，正式测试以仓库 `tests/` 为准。

临时路径可能清理。此文保存结论/清单/校验和，但未将第三方源码、截图、日志或压缩包复制进 Git。后续若需永久归档，应由用户确定私有存储位置，先审查秘密、隐私和复用授权，再归档选定材料。不能声称目前导出已完整备份。

### 仍缺的材料

1. 部署层 `docker-compose.yml`、Dockerfile、entrypoint/18082 转接脚本的脱敏版本，用于把链路中间段最终确认。
2. `ip_rights_module/server.mjs` 及 manifest，若要理解 8765 业务；建设最小设备控制端并不以它为前置。
3. `core/agents/product_scan_agent.py`、`api_scan_agent.py`、完整平台 collectors/workflow、输入/剪贴板集成；目前不能声称已审阅全部采集链。
4. 旧前端视频解码/输入实现、PoC APK 源码与授权、准确 Git 版本/作者来源。

继续收集只要相关源码，不要导出 `.env`、真实 config、SQLite 数据库、`.android` 私钥、`.claude` 登录态、known_faces、runs/reports 全量数据。

## 6. 旧源码可复用什么

下列行号对应第一份导出 `web_server.py`，将来版本变化时按函数名搜索。

| 函数 / 路由                                                               | 本次核实                                                                                    | mx-device 决策                                     |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `IP_RIGHTS_BASE` 约 475；`start_ip_rights_sidecar` 3095；`main` 3142 附近 | Node 业务 sidecar + Python 主服务 + 视频 + 定时调度组合启动                                 | 不依赖整套旧业务作为设备中心的启动条件             |
| `capture_screen` 1151；GET `/api/screen.png`                              | 对指定 serial 执行 `exec-out screencap -p`                                                  | 已只读适配，保留限流/超时/原比例                   |
| `stream_screen` 2373；`/api/screen.mjpeg`                                 | multipart 内是 PNG，名称不等于 JPEG 编码                                                    | 暂不直连长流                                       |
| `stream_screenrecord_video` 1223、`stop_device_screenrecord` 1195         | H.264 流；异常/断开清理有 `pkill screenrecord`，可能影响别的录屏消费者                      | 8788 暂不启用，不能宣称“只看流绝对无副作用”        |
| `api_devices` 1740、`api_device_detail` 1748                              | 默认读旧库；`refresh=1` 会查询 ADB 并刷新旧记录                                             | 已选 detail 的缓存读取；不静默触发发现             |
| `api_runs_state` 2345；GET `/api/run`                                     | 多 serial runner + legacy 摘要，含日志/元数据                                               | 已按目标 serial 过滤，只保留报告字段               |
| GET `/api/state` 2544                                                     | 含配置等广泛信息；与 PoC 的同名路径不是同一接口                                             | 不作为中心通用探测接口                             |
| `run_device_action` 1350；POST `/api/devices/{serial}/action`             | open/restart app、tap、swipe、back/home、like、clear_background；无 mx-device 租约/代次验证 | 当前不调用；不能复制“清后台”的查询失败后无保护行为 |
| `task_runner.py` / `schedule_runner.py`                                   | 按设备 runner、SQLite current_task_id、定时及 queued drain                                  | 借鉴资源身份，不复制成中心里的第二个调度器         |
| `recover_stale_tasks` / `main` 启动流程                                   | 重启会清设备任务锁并标失败，还可能恢复定时领取                                              | 不把重启旧服务当无害探测或标准恢复手段             |

旧 README 还描述 Claude Agent SDK、mobilerun Portal/输入法/无障碍、豆包视觉等业务依赖。**这是旧业务 README 的声明，不代表当前手机全部已安装/启用，也不是 mx-device 观察所需的最小依赖。** 现有已导出 HTTP action 层没有通用文本输入、UI hierarchy 或显式 Activity 启动契约；不要虚构这些入口。

多设备支持的证据：ADBController 命令支持 `-s serial`，runner 按 serial 分开，设备库按 serial 存储。故同一宿主机增加第二台手机优先复用同一个 8787、传不同 serial，**不是每台必增公开端口**。这不保证所有未导出业务脚本已严格按 serial 隔离；真实并发必须逐链验收。旧 PoC 全局入口则需逐手机隔离的映射/路由，不能仅改注册表 serial。

## 7. 公开项目调查与建议

公开资料核查日 2026-10-10。按本地项目标题“侵权中台”和 `start_ip_rights_sidecar` 等特征检索，未定位能确认匹配的公开仓库。没有 `.git`/remote/版权证据，**不能把服务器项目认定为 X-PLUG/MobileAgent 的原版或已证明的 fork**。下列是候选技术来源，不是来源鉴定。

| 官方项目                                                        | 已核实能力                                            | 对本项目的建议（方案判断）                                                                                                        |
| --------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| [X-PLUG/MobileAgent](https://github.com/X-PLUG/MobileAgent)     | GUI 智能体系列，仓库 MIT；覆盖移动 GUI 感知与操作研究 | 可作未来可选规划器，不当硬件驱动、设备锁或可靠调度器；模型权重/API 条款另查                                                       |
| [Genymobile/scrcpy](https://github.com/Genymobile/scrcpy)       | Android USB/TCP 画面与输入控制，Apache-2.0            | 优先评估为新控制端的底层画面/输入组件；不是直接可嵌入浏览器的现成设备中心                                                         |
| [openatx/uiautomator2](https://github.com/openatx/uiautomator2) | Android UI 自动化、定位/操作/层级等，MIT              | 确定性 UI 流程候选；部署依赖和手机端组件需按锁定版本审计，不直接安装到现役手机                                                    |
| [openatx/adbutils](https://github.com/openatx/adbutils)         | ADB 服务 Python 客户端，支持设备选择与命令，MIT       | 可用于新代理的受限传输封装；它本身不提供跨控制者的所有权仲裁                                                                      |
| [DeviceFarmer/STF](https://github.com/DeviceFarmer/stf)         | 浏览器管理/远程控制设备的设备农场项目                 | 借鉴设备资源、会话、Provider 与观察 UI；不因名称相近就直接并行部署抢现有 ADB。需核对目标 Android 兼容性、维护成本及该版本 LICENSE |

scrcpy 的“无需安装常驻 App”不表示手机端没有执行任何新代码：其客户端会推送并启动设备端 server，视频/音频/控制分通道。具体集成必须锁定版本并审阅协议；不能把原 8788 的 screenrecord 流误叫 scrcpy。[官方开发说明](https://github.com/Genymobile/scrcpy/blob/master/doc/develop.md)

scrcpy 在多设备时可按 serial 选择。未来一台宿主机一个代理、每台手机一个内部会话/控制槽、对外一个受认证入口即可，不必将每手机私有传输端口公开。[官方连接说明](https://github.com/Genymobile/scrcpy/blob/master/doc/connection.md)

这些开源部件的功能/许可证只针对相应上游版本；本地定制代码不能自动继承同名项目的授权。复用前补充固定 commit/tag、依赖清单、来源/许可记录、安全审查和兼容测试。本次未下载或执行任何公开项目。

## 8. 总体选择

**现在：** 保持旧容器/手机不变，mx-device 只读复用 8787，18081 是可停用的旧能力。继续用 mock 完善调度/控制协议。

**以后：** mx-device 管理业务逻辑、队列和可视化；独立 Host Agent 统一手机写入口，可组合 ADB/scrcpy/可选 UI 自动化；业务采集插件和 GUI AI 规划器都经同一所有权闸门。要做到“全面控制”，须经批准收拢或隔离旧写入口，不能一边允许旧程序任意 ADB、一边宣称新中心已全局独占。详细实施拆分见 [产品路线](product-roadmap.md)。
