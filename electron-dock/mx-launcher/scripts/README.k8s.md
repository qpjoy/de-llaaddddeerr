```bash
# 设置硬盘pressure大小
K8S_KUBELET_EVICTION_NODEFS_AVAILABLE=20Gi \
  K8S_KUBELET_EVICTION_IMAGEFS_AVAILABLE=20Gi \
  bash scripts/install-k8s-centos.sh --skip-init --skip-flannel --skip-firewall

# 查看硬盘pressure大小
grep -n '^evictionHard:' -A6 /var/lib/kubelet/config.yaml
sudo systemctl restart kubelet
kubectl get node miwifi-rd04-srv -o jsonpath='{range .status.conditions[?(@.type=="DiskPressure")]}{.status}{" "}{.message}{"\n"}{end}'

# 查看硬盘大小
df -hT / /var /var/lib/kubelet /var/lib/containerd /var/lib/docker /var/log /tmp
findmnt -T /var/lib/kubelet -o TARGET,SOURCE,FSTYPE,SIZE,AVAIL,USE%
findmnt -T /var/lib/containerd -o TARGET,SOURCE,FSTYPE,SIZE,AVAIL,USE%
docker info --format 'DockerRootDir={{.DockerRootDir}}'
sudo grep -E '^(root|state) =' /etc/containerd/config.toml
```
