```bash
# 本机初始化
bash scripts/manage.sh local init
# up
bash scripts/manage.sh local up
# down
bash scripts/manage.sh local down

# 获取rig admin token
bash scripts/manage.sh local token

# 本地启动
bash scripts/manage.sh local desktop
```

```bash
# 启动rig server
PROXY=http://127.0.0.1:7788 bash scripts/manage.sh deploy
bash scripts/manage.sh status
bash scripts/manage.sh verify
bash scripts/manage.sh admin-token
```