```bash
cd /root/workspace/qpjoy/de-lader-formal
sudo bash ./docker/wg-mihomo-stack/manage.sh destroy --wipe-data --wipe-env --yes
sudo bash ./docker/wg-mihomo-stack/manage.sh setup


sudo bash ./docker/wg-mihomo-stack/manage.sh add-user --names user02,user03
sudo bash ./docker/wg-mihomo-stack/manage.sh del-user --names user03
sudo bash ./docker/wg-mihomo-stack/manage.sh set-limit --names user02 --down-ceil 9mbit --up-ceil 9mbit
sudo bash ./docker/wg-mihomo-stack/manage.sh reconfigure
sudo bash ./docker/wg-mihomo-stack/manage.sh restart wireguard
sudo bash ./docker/wg-mihomo-stack/manage.sh status

bash ./docker/wg-mihomo-stack/manage.sh add-user --names intelligent02,intelligent03,intelligent04,intelligent05,intelligent06,intelligent07,intelligent08,intelligent09
```