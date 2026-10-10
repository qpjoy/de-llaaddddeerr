# Harbor 设计组件

样式基线为 `/tmp/dataport`。`styles/dataport.css` 与组件源码初次抽取保持原样；`source-manifest.json` 记录来源文件和 SHA256，方便对照后续变化。

React 组件依赖由 Harbor 根 package-lock 固定；`@/` 映射到本目录。此包不包含 Next.js 服务端、自有账号、演示订单或支付模拟器。业务适配与 Harbor 少量补充样式放在 `apps/web/`。

运行 `npm run dev:gallery`，访问 `http://127.0.0.1:4279/demos/ui-design-harbor/`。预览提供首页、控制台壳、登录与邀请注册；fixture 明确标注为设计预览，不提交账号或调用真实服务。
