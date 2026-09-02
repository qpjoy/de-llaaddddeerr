# 22 · Webhook 触发

> 五件待办的最后一件：合并到主干自动建 run。

---

## 1 · 唯一一条无鉴权的路由

`POST /webhooks/v1/git/:app` 是平台里唯一不要求登录的路由。整份实现都是从这个前提写的：

> **请求在签名通过之前是敌意的；通过之后，payload 也只是"该跑哪个任务"的提示，
> 而不是"跑什么"的指令。**

这个区分最要紧的地方是一条：

**检出永远用应用登记的仓库地址，绝不用 payload 里的。**

一个声称"clone 这个别的仓库"的投递，否则就是让平台去拉取并执行任意代码的路子。
签名让那件事变得不太可能；**根本不读那个字段让它变得不可能**。

有测试专门锁这条：投递里塞 `repository.clone_url = attacker/evil`，
建出来的 run 里不含 `attacker` 任何痕迹。

---

## 2 · 签名

GitHub 用 `X-Hub-Signature-256: sha256=<hmac>`。三个实现细节：

**① 对原始字节验签，不对解析后的对象。**
先 `JSON.parse` 再 `JSON.stringify` 会得到不同的字符串——键序、空白、unicode 转义
都可能变——**没有任何一次真实投递能验过**。所以这条路由用 `rawBody`，
读原始 Buffer 验签，验过之后才解析。

**② 常量时间比较。** 用 `!==` 会通过时间差泄漏正确前缀，
有耐心就能一位一位试出签名。

**③ 没配密钥就全拒。** 一个不验签的 webhook 端点，等于一个公开的
"运行这些已登记作业"按钮。失败要在**配置的时候**可见，而不是永远静默放行。

密钥用和密钥库同一把钥匙加密落库（[20](20-secret-store.md)）——
拿到它的人可以伪造投递，而每晚的 `pg_dump` 会进 OSS。

**按应用一把，不是全平台一把**：撤销某个仓库的接入，
不该意味着要去重配其他每个仓库的 webhook。

---

## 3 · 无关事件安静忽略，不是拒绝

`ping` 回 `200 {pong:true}`——**这是 GitHub 界面上那个绿勾的来源**，
也是配置的人判断"接通了没有"的唯一依据。

star、issue 评论、PR 打开……一律 `200 {ignored:true}`。

理由很实际：**一个对每条无关事件都返回 4xx 的端点，会把 provider 的界面刷红，
然后被看到的人直接关掉整个 webhook。**

tag 推送、分支删除（全零 sha）、非法 sha 也都归到"没有可测的东西"，同样安静。

---

## 4 · 哪些任务会被触发

任务的 `schedule.kind` 加了第四个值 `webhook`。只有它会响应推送——
`manual` / `once` / `cron` 都不动。

**任务响应的分支，就是它会检出的分支**（`suite.defaultBranch ?? app.defaultBranch`），
不是一个独立配置项。

这是刻意的：两者独立就会造出一个陷阱——**一个在推送到 A 分支时触发、
却去测 B 分支的任务**。让它们由构造保证相同，那个陷阱就搭不起来。

> 代价：目前不能做"任何分支推送都跑一遍 mock"的 PR 校验。
> 那需要一个分支过滤器，等真要做 PR 门禁时再加。

"每晚跑" 和 "合并即跑" 是**两个任务**，不是一个任务的两种触发。
这和 [18 §1](18-notifications.md) 的判断一致：同一套件上的两个任务是两路独立信号。

---

## 5 · run 钉在那个 commit 上

这是整件事的价值所在：

```json
"sourceRef": { "ref": "public", "gitSha": "1111...1111" }
```

**没有这一条，run 测的是机器真正开始跑时分支尖端碰巧是什么。**
桌面任务可能排队几小时，期间分支早就动了。

---

## 6 · 重复投递不会建两次

provider 会重试，同一个 sha 也可能由别的路径再来一次（force-push 落到同一个 sha、
有人手动点了重新投递）。

去重键是 **(任务, commit)**，不是 provider 的投递 id——
后者盖不住上面那几种情况。数据库上有唯一索引兜底。

**手动重跑同一个 commit 仍然可以**：那条路不走这里。

---

## 7 · 怎么配

### 7.1 生成并设置密钥

```bash
openssl rand -hex 24        # 记下来，两边要填同一个

curl -X PUT "$MXT_URL/api/v1/apps/luopan/webhook-secret" \
  -H "authorization: Bearer $MXT_ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"secret":"刚生成的那个"}'
```

返回里直接给出要填进 GitHub 的地址：

```json
{ "url": "http://<内网 IP>:30879/webhooks/v1/git/luopan", "note": "..." }
```

> **前提**：GitHub 要能访问到这个地址。内网地址从公网是打不通的——
> 需要一个反向代理，或者用自托管的 git 服务。
> 这是这条功能唯一的外部依赖，也是最容易卡住的一步。

### 7.2 在仓库里加 webhook

Settings → Webhooks → Add webhook：

| 字段 | 填什么 |
| --- | --- |
| Payload URL | 上面返回的 `url` |
| Content type | `application/json` |
| Secret | 刚才那个 |
| Events | **Just the push event** |

加完 GitHub 会立刻发一次 `ping`，**看到绿勾就是通了**。

### 7.3 建一个 webhook 任务

```bash
curl -X POST "$MXT_URL/api/v1/tasks" -H "authorization: Bearer $MXT_ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"app":"luopan","suite":"web-mock","name":"合并即跑","profile":"mock",
       "track":"functional","schedule":{"kind":"webhook"}}'
```

它只会在推送到 `public`（罗盘的 `defaultBranch`）时触发。

### 7.4 轮换密钥

再 `PUT` 一次即可，**立即生效**，旧密钥当场失效。有测试锁这条。

---

## 8 · 需要斟酌的点

**① 触发频率。** 主干每天合十次，就是十次全量 e2e。
如果单次跑要十几分钟，队列会堆积。两个应对：把 webhook 任务指向轻量的 suite
（mock 全量而不是 real），或者等分片做完再开。

**② `blocked` 会变多。** 推送触发意味着有人推了一个装不上依赖的 commit 时，
平台会立刻告诉你——这是好事，但要确保 `blocked` 走的是运维群
（[18 §1](18-notifications.md)），别刷业务群。

**③ 内网可达性是最容易卡住的一步。** 见 §7.1。
如果 GitHub 到不了内网，这条功能就用不了——那时的替代是让 CI（GitHub Actions）
在合并后调 `POST /api/v1/tasks/:id:run`，方向反过来，从内向外。

---

## 9 · 还没做的

| 项 | 说明 |
| --- | --- |
| 分支过滤器 | 目前只响应"任务会检出的那个分支"。PR 校验需要它 |
| GitLab / Gitea | 签名头和 payload 形状不同。解析集中在 `webhooks.mjs` 一个函数里，加一个 provider 是小改动 |
| 界面上配 webhook | 目前只有 API |
| 投递记录 | 收到过哪些投递、为什么被忽略，现在只进日志。真要排查"为什么没触发"时需要它 |
