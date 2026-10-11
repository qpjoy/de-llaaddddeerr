# Harbor 设计组件

样式基线为 `/tmp/dataport`。`styles/dataport.css` 与组件源码初次抽取保持原样；`source-manifest.json` 记录来源文件和 SHA256，方便对照后续变化。

React 组件依赖由 Harbor 根 package-lock 固定；`@/` 映射到本目录。此包不包含 Next.js 服务端、自有账号、演示订单或支付模拟器。业务适配与 Harbor 少量补充样式放在 `apps/web/`。

运行 `npm run dev:gallery`，访问 `http://127.0.0.1:4279/demos/ui-design-harbor/`。预览提供首页、控制台壳、登录与邀请注册；fixture 明确标注为设计预览，不提交账号或调用真实服务。

控制台沿用原设计的 `SidebarMenuButton` 和 `data-active` 选中态；不要用裸按钮替换，否则会丢失图标与文字的横排布局。支付订单、账户安全和退出登录集中在底部账户上拉菜单，使用现有 Harbor 路由。业务卡片、表格和空状态使用 `harbor-console` 下的样式适配原设计，源样式无需改写。

登录弹窗保留数港双栏设计，右侧表单独立滚动，关闭按钮始终可达；手机为单栏。样式验收覆盖桌面 1280×720、矮屏 1280×600、手机 390×844，检查登录与邀请注册、侧栏菜单、账户设置、表格及空状态。
