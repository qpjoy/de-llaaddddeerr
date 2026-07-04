set -euo pipefail

STAMP="$(date +%Y%m%d%H%M%S)"
DATA_ROOT="/data/mx-runtime"
BACKUP="/data/mx-backup/$STAMP"

mkdir -p "$BACKUP" "$DATA_ROOT"/{containerd,kubelet,etcd,mx-launcher}
cp -a /etc/fstab "$BACKUP/fstab" 2>/dev/null || true
cp -a /etc/containerd "$BACKUP/containerd-etc" 2>/dev/null || true

systemctl stop kubelet || true
systemctl stop docker || true
systemctl stop containerd || true

rsync -aHAX --numeric-ids /var/lib/containerd/ "$DATA_ROOT/containerd/" 2>/dev/null || true
rsync -aHAX --numeric-ids /var/lib/kubelet/ "$DATA_ROOT/kubelet/" 2>/dev/null || true
rsync -aHAX --numeric-ids /var/lib/etcd/ "$DATA_ROOT/etcd/" 2>/dev/null || true
rsync -aHAX --numeric-ids /var/lib/mx-launcher/ "$DATA_ROOT/mx-launcher/" 2>/dev/null || true

mv /var/lib/containerd "/var/lib/containerd.before-data-move-$STAMP" 2>/dev/null || true
mv /var/lib/kubelet "/var/lib/kubelet.before-data-move-$STAMP" 2>/dev/null || true
mv /var/lib/etcd "/var/lib/etcd.before-data-move-$STAMP" 2>/dev/null || true
mv /var/lib/mx-launcher "/var/lib/mx-launcher.before-data-move-$STAMP" 2>/dev/null || true

mkdir -p /var/lib/containerd /var/lib/kubelet /var/lib/etcd /var/lib/mx-launcher

mount --bind "$DATA_ROOT/containerd" /var/lib/containerd
mount --bind "$DATA_ROOT/kubelet" /var/lib/kubelet
mount --bind "$DATA_ROOT/etcd" /var/lib/etcd
mount --bind "$DATA_ROOT/mx-launcher" /var/lib/mx-launcher

grep -q ' /var/lib/containerd ' /etc/fstab || echo "$DATA_ROOT/containerd /var/lib/containerd none bind 0 0" >> /etc/fstab
grep -q ' /var/lib/kubelet ' /etc/fstab || echo "$DATA_ROOT/kubelet /var/lib/kubelet none bind 0 0" >> /etc/fstab
grep -q ' /var/lib/etcd ' /etc/fstab || echo "$DATA_ROOT/etcd /var/lib/etcd none bind 0 0" >> /etc/fstab
grep -q ' /var/lib/mx-launcher ' /etc/fstab || echo "$DATA_ROOT/mx-launcher /var/lib/mx-launcher none bind 0 0" >> /etc/fstab

mount -a
systemctl daemon-reload
systemctl start containerd
systemctl start docker || true
systemctl start kubelet