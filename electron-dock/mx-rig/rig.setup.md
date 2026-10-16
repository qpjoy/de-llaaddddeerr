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

# 完成 Rig 自己的 Launcher 登记
bash scripts/manage.sh launcher plan
# launcher key 或者写入 .env
export MX_LAUNCHER_OPS_TOKEN="$(
  kubectl -n mx-internal-shadow get secret mx-internal-ops \
    -o jsonpath='{.data.token}' | base64 -d
)"

bash scripts/manage.sh launcher apply
unset MX_LAUNCHER_OPS_TOKEN

# rig注册到launcher
# Sync Domestic CIDRs


# launcher模式启动
env -u ELECTRON_RUN_AS_NODE -u MX_RIG_SERVER_URL \
  MX_RIG_LAUNCHER=1 npm run desktop
```