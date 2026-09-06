# 20 · 密钥库与注入

> 五件待办的第三件。`suite.secretRefs` 从第一版就存在，但**只存名字、从不注入**——
> 被测应用永远拿不到测试账号口令，所以 `real` profile 的无人值守一直做不了。
> 这是把它接通。

---

## 1 · 先解决一个设计冲突

两份 spec 互相矛盾：

- [ADR-0005](adr/0005-federated-identity-and-runner-tokens.md)：凭据"注入进程环境"
- [13 §1.3 第 13 条](13-platform-review-and-redesign.md)：env 会出现在
  `/proc/<pid>/environ`、崩溃转储、子进程，**改为挂载文件**

**结论：环境变量胜出**，两个理由：

1. **每个测试框架都从 env 读配置**——`Cypress.env()`、`process.env`、`os.environ`。
   要求读文件意味着每条 suite 都要写平台专属代码，那会摧毁"零适配"这个
   让它成为平台的性质（[16 §0](16-multi-stack-platform.md)）。
2. **对本地执行机，文件的论证是反的。** 文件会在崩溃后**留在别人的私人电脑上**；
   环境随持有它的进程一起消失。

但 13 号文档担心的东西是真的。所以它由另外四件事回答，**而不是由交付方式回答**：

| 防护 | 做法 |
| --- | --- |
| 凭据不进 k8s Job manifest | 任何能 `kubectl get job -o yaml` 的人都能读 manifest。改为容器**运行时用 run token 去取** |
| 凭据不进容器里 shell 的环境 | curl 写文件 → node 包装器读取、`unlink`、只合并进**被测进程**的 env。`/proc/<shell pid>/environ` 始终干净 |
| 结果里按**精确值**脱敏 | 平台知道自己下发的确切字符串，比模式匹配强得多 |
| 落库加密 | 因为每晚的 `pg_dump` 会进 OSS |

---

## 2 · 为什么必须加密落库

这一条不是仪式感，有具体理由：

[14 §2](14-ci-runners-and-stack.md) 定的备份策略是**每晚 `pg_dump mx_test` 传到 OSS**。
明文存库意味着那些测试账号口令进了对象存储——那是另一套访问模型、另一个保留期，
和当初输入它们的人预期的完全不同。

实现：AES-256-GCM，密钥在 `MXT_SECRET_KEY`（数据库之外），所以**光有 dump 不够**。

- 每次加密用新的 IV → 同一个口令两次落库密文不同，
  否则拿到表的人能看出哪些账号共用了口令
- GCM 带认证 → 密钥错或行被篡改会**抛错**，而不是解出一段看似合理的垃圾
  然后被当成口令注入测试
- **没配 `MXT_SECRET_KEY` 就拒绝保存密钥**，不退化成明文。
  拒绝发生在有人配置它的那一刻，而不是几个月后

`manage.sh deploy` 首次自动生成，之后从 Secret 读回——**不轮换**。
每次部署换一把新钥匙会让所有已存口令解不开，
而那个故障的表现是"测试莫名其妙登不上去"。

---

## 3 · 写进去就拿不出来

平台**没有任何一条路由能把口令返回给人**。列表只返回名字、描述和更新时间。

理由很直接：需要那个值的人本来就有它；不该有的人，不该能从平台里再取出来。

审计记录同理——`secret.put` 记录名字和"改过了"这件事，**值根本不传给审计**。

---

## 4 · 谁能取到值：只有本次执行的 run token

写测试时端到端验证，发现**长期的 runner token 也能取到密钥**。

这违反 [ADR-0005](adr/0005-federated-identity-and-runner-tokens.md) 明写的
"runner token 不能读写任何 run 的数据"，而且对密钥比对产物严重得多：

> ADR-0005 的整个论证是"run 作用域 + 自动过期把爆炸半径压到这一次执行"。
> 让一个长期 token 能取到同一份凭据，等于把那个论证还回去了——
> runner token 一旦泄露，就等于随时可以读测试账号口令。

已收紧：`/runner/v1/runs/:runId/secrets` 用 `auth: 'runToken'`，
**只认本次执行的 run token**，runner 的长期 token 和 admin token 都返回 403。

（产物上传和结果回报仍然两种都收——那是执行机自己的工作，
崩溃后重新认证是合理的便利。凭据不一样。）

---

## 5 · 按精确值脱敏

`core/redact.mjs` 靠形状猜——`Bearer ...`、`password=...`。它抓不到这种：

```
login failed for user qa with P@ssw0rd-do-not-leak at auth.cy.ts:9
```

文本里没有任何东西说明那是口令。但**平台知道自己下发的确切字符串**，
所以入库前可以精确抹掉：

```
login failed for user qa with [REDACTED_SECRET] at auth.cy.ts:9
```

实测通过。两个细节：

- **短于 6 个字符的值跳过**。把每个出现的三字符口令都替换掉，会破坏无关文本、
  让报告不可读——那是另一种失败。
- **尽力而为**。密钥轮换后旧值解不开时，不能因此丢掉一条已经记录的结果。

---

## 6 · 怎么用

### 6.1 存一个密钥

```bash
curl -X PUT "$MXT_URL/api/v1/apps/luopan/secrets/LUOPAN_TEST_PASSWORD" \
  -H "authorization: Bearer $MXT_ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"value":"只读测试账号的口令","description":"read-only QA account"}'
```

名字必须能当环境变量用：大写字母、数字、下划线，字母开头。

### 6.2 让 suite 声明它要什么

```json
{ "slug": "real", "secretRefs": ["LUOPAN_TEST_PASSWORD"], ... }
```

**suite 只拿到它声明的，别的一个都没有。**

### 6.3 用例里读

```js
// Cypress
const password = Cypress.env('LUOPAN_TEST_PASSWORD')
// Playwright / Node
const password = process.env.LUOPAN_TEST_PASSWORD
```

```python
# pytest
password = os.environ["LUOPAN_TEST_PASSWORD"]
```

### 6.4 缺了会怎样

**`blocked`，附明确原因。** 不是静默跑下去。

一条 suite 要了口令却在没有口令的情况下启动，会在登录表单里失败，
报告写的是"元素找不到"——排查方向被带偏几个小时。所以缺失是错误，不是省略。

---

## 7 · 需要斟酌的点

**① `MXT_SECRET_KEY` 丢了 = 所有口令作废。** 它只在 k8s Secret 里。
如果整个 namespace 被删掉重建，密钥库里的东西全部解不开，需要重新录入。
**这是可接受的**——重新录入几个口令的成本，远低于把密钥再备份一份到别处的风险。

**② 不要把它当通用配置存储。** 它是给"被测应用的登录凭据"用的。
非敏感配置走 suite 的普通字段或环境。

**③ 临时执行机不派 `real` profile 的任务**（[14 §3](14-ci-runners-and-stack.md)）。
`real` 会拿到真实测试账号；临时机跑在别人的私人电脑上。这条规则**还没有强制实现**，
目前只是约定。

**④ 用例自己把口令打进截图，平台管不了。** 脱敏作用于文本字段。
如果用例截了一张显示明文口令的页面，那张图会被原样存下来。
防线在前置：`real` 用只读测试账号，测试账号不接触真实客户数据。

---

## 8 · 还没做的

| 项 | 说明 |
| --- | --- |
| 界面上的密钥管理 | 目前只有 API |
| 密钥轮换流程 | 换 `MXT_SECRET_KEY` 需要先解密再用新钥匙重新加密。**还没有这个命令** |
| 临时机禁止 `real` 的强制实现 | 见 §7 ③ |
| 产物内容扫描 | 见 §7 ④。成本过高，防线在测试账号本身 |
