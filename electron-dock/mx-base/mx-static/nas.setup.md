# NAS
```bash
# 
/etc/systemd/system/docker.service.d/20-requires-nas.conf



# 状态查看
bash scripts/manage.sh nas project list
bash scripts/manage.sh nas host status
bash scripts/manage.sh nas infra status
bash scripts/manage.sh nas infra deployment audit
bash scripts/manage.sh nas infra permissions check

# 权限检查使用容器配置的默认用户和组。需要验证实际写入时执行：
bash scripts/manage.sh nas infra permissions probe --write-test
bash scripts/manage.sh nas infra logs

# 持久开机恢复统一这样安装、检查、启用：
bash scripts/manage.sh nas recovery install
bash scripts/manage.sh nas recovery check infra
bash scripts/manage.sh nas recovery enable infra

# 清理和第二卷预复制也已有统一入口：
bash scripts/manage.sh nas infra task part1 cleanup --business-accepted
bash scripts/manage.sh nas delta task part2 copy --unlimited

# compose.nas.override.json 保存在服务器的成功报告目录
bash scripts/manage.sh nas infra locate


# 第一阶段尝试 cleanup
bash scripts/manage.sh nas infra cleanup check --business-accepted
# 确认cleanup
bash scripts/manage.sh nas infra cleanup --business-accepted
# 删除前，应该执行
bash scripts/manage.sh nas infra locate &&
bash scripts/manage.sh nas recovery install &&
bash scripts/manage.sh nas recovery check
```

# Delta
```bash
bash scripts/manage.sh nas delta copy --unlimited
```