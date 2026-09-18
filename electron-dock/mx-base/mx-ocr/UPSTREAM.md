# 来源记录

- 上游：https://github.com/qpjoy/knock-ocr
- 固定提交：`5224b46e501c60b415905cd809e9a4e1a73c1b9d`
- 引入日期：2026-09-19
- 原 README 移至 `docs/UPSTREAM-README.md`；原管理脚本移至 `scripts/upstream-manage.sh`。
- 原应用、Dockerfile、历史文档和 multipart 测试随提交引入，未合并后续远程修改。
- 本地适配：新增统一管理包装器、mx-ocr 名称、GPU 检查、默认回环监听及资源限制；容器增加 `com.mx-base.app=mx-ocr` 标签；deploy 在镜像准备成功后再替换容器；切到 fast 时释放旧 vLLM 容器；显示名称改为 MX OCR；诊断和测试使用实际绑定地址，支持受控内网监听。
- 上游此提交没有独立 LICENSE 文件。保留原出处；此次为用户指定的自有项目整合，不额外声明第三方代码许可证。模型和依赖遵循各自许可证。

后续更新应先比较固定提交与新提交，再移植本地适配，不能在 deploy 时自动 git pull。
