1. Identity 和 Known Hosts 是 Internal 上的路径，不是 Oversea 上的路径。
- Identity：Internal 保存的 SSH 私钥路径，用来从 Internal 登录 Oversea。
- Known Hosts：Internal 保存的 known_hosts 文件路径，用来校验 Oversea 主机指纹。
- Oversea 上被写入的是 ~/.ssh/authorized_keys，不是这两个路径。
可以默认。推荐你不要手填这两个字段，走 Bootstrap Key 后 Internal 会自动生成默认路径。
2. Host Alias / Strict / Batch 的含义：
- Host Alias：known_hosts 里的主机别名。默认用 site id，比如 oversea-sg-1 就行。主要用于主机 IP 变化、端口变化、或想用稳定名字记录主机指纹。
- Strict=yes：严格校验 host key，防止连到被替换的服务器。真机建议保持 yes。
- Batch=yes：SSH 不进入交互式密码提示，适合后台 runner/job。真机部署建议保持 yes，避免任务卡死等输入。

3. 推荐操作顺序：
第一次空 Ubuntu：
3.1. 填 Site / Kind / Host / User / Password / Port。
3.1.1. `HY2 UDP` 是客户端连接 Oversea Hysteria2 的 UDP 端口，默认 `51288`。
3.1.2. `Health TCP` 是 Oversea health/evidence 出口，默认 `3434`；如果旧服务已经占用
      `3434`，填 `3435` 或其它空闲 TCP 端口。Run Setup 会把它写入远端
      `HY2_EXPORT_FALLBACK_PORT` 并使用同一端口做 health smoke。
      Save Profile 只保存 SSH 凭据；这两个端口随 Create Plan / Shadow Setup / Run Setup 生效。
3.2. Rotate 不勾选。
3.3. 点 Bootstrap Key。
3.4. 成功后它会自动保存 profile，并回填 Internal 默认的 Identity / Known Hosts 路径。
3.5. 点 Check Readiness。
3.6. 再点 Create Plan。
3.7. 后面走 Preflight -> Confirm Apply -> Runner -> Worker Job -> Worker Run -> Evidence。
Save Profile 只是把当前表单保存进 Config Center，不会生成 key，也不会登录服务器。第一次真机建议直接用 Bootstrap Key，不需要先手动 Save Profile。


```bash
# Terminal 0
bash scripts/manage.sh ops k8s-shadow cycle
bash scripts/manage.sh ops k8s-shadow ssh-bootstrap enable
bash scripts/manage.sh ops k8s-shadow readonly-probe enable
bash scripts/manage.sh ops k8s-shadow remote-runner enable

# Terminal 1
# kubectl -n mx-internal-shadow port-forward svc/mx-launcher-internal 18090:18090
bash scripts/manage.sh ops internal-local port-forward

# Terminal 2
python3 -m http.server 18110 --directory desktop
```

`k8s-cycle` 会重新 apply / rollout Internal API。SSH Profile 记录会保存在 PostgreSQL，
但 SSH 私钥和 known_hosts 必须落在 `/app/artifacts/ssh` 的 PVC 或生产 Secret/PVC 中。
如果界面提示 identity / known_hosts 不存在，说明当前 Pod 里没有对应文件，需要在 PVC 挂载后
重新执行 Bootstrap Key。
