# 字体、客服导航与子账号弹窗复核（2026-10-16）

参考工作区只读的 `dataport` 原型。修改仅位于 `electron-dock/mx-dataport`，不涉及 Hub、Launcher/Auth、迁移和真实数据接口。

本次使用 Chrome 在 1440 × 1000 和 390 × 844 两种视口，对照当前截图和 DOM 计算样式检查：公开首页、登录、定价、新建查询、历史结果、用量概览、API Keys、我的订阅、账单与开票、接口文档、企业账号、日志审阅、服务工单，以及相关弹窗和手机侧栏。

## 修正内容

- 全局采用原型的 `antialiased`，消除相同字号仍显粗的差异；继续使用原型字体族和 100% 根字号。
- 常规页标题恢复为桌面 28px、手机 24px；查询页保持原型单独定义的响应式字号。
- 删除客服入口的旧外边距与高度覆盖，用与原型相同的原生按钮保留 23px 耳机图标、14px / 500 文字、10px 间距与 12px 内边距。桌面按钮实测 199 × 47，左边距 12；手机 263 × 47，左边距 12。保留原型悬停颜色，点击后关闭手机侧栏。
- 查询历史的 IP 字重改为 550，手机表格为 12px；详情和分页按钮恢复 14px。Excel 导入恢复桌面 13px、手机 11px。
- 修正结果 IP 标题、资料标签颜色/行高、风险标签标题、建议正文及说明小字，删除与原型冲突的旧建议区样式。
- 普通业务表格按原型区分 13px 粗体表头与查询历史的紧凑表头；成员账号小字为 11px。
- 新建子账号采用原型的标题、说明、必填标记、字段间距与按钮；创建和关联入口分开。密钥、工单、登录与开票表单同时校正文字和控件尺寸。

| 子账号弹窗元素 | 原型与应用的最终值 |
| --- | --- |
| 标题 | 19px / 600，行高 26.6px |
| 标题说明 | 13px / 400，行高 23.4px |
| 字段标签、输入文字 | 13px / 400，行高 19.5px |
| 输入框、角色选择框 | 41.5px 高，10px 12px 内边距 |
| 底部提示 | 12px / 400，行高 18px |
| 创建按钮 | 14px / 500，36px 高 |

子账号仍由统一 MX 认证创建，保留角色选择和服务端生成初始密码。因此登录字段为 MX 账号，底部提示为“初始密码自动生成，仅企业超管可在列表中查看和复制。”，不添加原型独立账号系统的邮箱/自选密码字段。已有 MX 账号仍需员工本人确认加入。

## 当前截图

截图已迁至工作区本地目录 `/Users/lanan/Desktop/yjj/数港/screenshot/`，不随代码仓库分发；以下链接按当前工作区结构访问。

| 视图 | 原型 | 应用 |
| --- | --- | --- |
| 查询及桌面侧栏 | [原型](../../../../screenshot/typography-20261016/source-query-final.png) | [应用](../../../../screenshot/typography-20261016/actual-query-final.png) |
| 桌面新建子账号 | [原型](../../../../screenshot/typography-20261016/source-dialog-final.png) | [应用](../../../../screenshot/typography-20261016/actual-dialog-final.png) |
| 手机新建子账号 | [原型](../../../../screenshot/typography-20261016/source-mobile-dialog-final.png) | [应用](../../../../screenshot/typography-20261016/actual-mobile-dialog-final.png) |
| 手机侧栏 | [原型](../../../../screenshot/typography-20261016/source-mobile-sidebar.png) | [应用](../../../../screenshot/typography-20261016/actual-mobile-sidebar.png) |

关键同名文字的计算样式见 [测量记录](typography-measurements-20261016.json)。业务记录数、商品描述、订阅状态和权限相关功能由各自后端决定，截图使用本地样例，不作为线上数据验收。

## 验证与部署

- `npm run typecheck`：通过。
- `npm run build`：通过。保留原有大体积 chunk 提示。
- `MX_SSO_TEST_DATABASE_URL=postgres://dataport@127.0.0.1:55477/dataport_sso_test npm test`：76 通过，0 失败，0 跳过。
- 浏览器只读展示页面、打开/关闭表单、查看已有历史结果；本地模拟 BFF 请求记录均为 GET，未提交查询、开户、邀请、Key、工单、订阅或付款。
- 本次上线只需重新构建/部署数港；无需重新部署 Hub 或 Auth。
