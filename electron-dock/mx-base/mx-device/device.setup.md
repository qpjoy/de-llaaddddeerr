```bash
TMPDIR=/data/tmp \
MX_DEVICE_BUILD_PROXY=http://127.0.0.1:7789 \
bash scripts/manage.sh deploy

bash scripts/manage.sh token


# 小红书作前台
docker exec mobile-agent adb -s 8ad5ef10 shell am start -W \
  -a android.intent.action.MAIN \
  -c android.intent.category.LAUNCHER \
  com.xingin.xhs

# 启动到前台
docker exec mobile-agent adb -s 8ad5ef10 shell am start -W --user 0 \
  -a android.intent.action.MAIN \
  -c android.intent.category.LAUNCHER \
  -n com.xingin.xhs/.index.v2.IndexActivityV2
```