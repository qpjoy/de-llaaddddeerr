#!/usr/bin/env bash
# QPJoy Marketplace — repo-wide management helper.
#
# One-stop entry for:
#   - status overview: server + every publishable package, local vs npm
#   - browse the bundled marketplace catalogue (registry/index.json)
#   - prepare a publish (bump → build → pack preview); then either print the
#     manual `pnpm publish --otp=...` step or publish directly if OTP is entered
#   - sync electron-demo / electron-test to the latest local workspace
#     state (re-pack tarballs + reinstall)
#   - dispatch into electron-server's docker manage.sh
#
# Usage:
#   scripts/manage.sh                       # interactive menu
#   scripts/manage.sh status
#   scripts/manage.sh market
#   scripts/manage.sh prepare-plugin
#   scripts/manage.sh sync-apps
#   scripts/manage.sh deploy                 # 部署菜单
#   scripts/manage.sh server <subcommand>   # → electron-server/scripts/manage.sh
#   scripts/manage.sh hdo-device-conflicts  # 查看 HDO overlay IP 冲突
#   scripts/manage.sh hdo-reset-devices     # 清 HDO 设备态，保留 Internal IP
#   scripts/manage.sh hdo <subcommand>      # → docker/hdo-gateway-stack/manage.sh
#   scripts/manage.sh nuke --all            # 清空 server/HDO 状态后重新部署
#
# Design note: publish stays operator-controlled. The script always prints the
# manual command first, then only runs `pnpm publish` when an OTP is entered.
set -Eeuo pipefail

# ── Locate repo root ───────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

# ── Colours ────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  C_RED=$'\033[1;31m'; C_GREEN=$'\033[1;32m'; C_YELLOW=$'\033[1;33m'
  C_BLUE=$'\033[1;34m'; C_CYAN=$'\033[1;36m'; C_DIM=$'\033[2m'
  C_BOLD=$'\033[1m';   C_RESET=$'\033[0m'
else
  C_RED=; C_GREEN=; C_YELLOW=; C_BLUE=; C_CYAN=; C_DIM=; C_BOLD=; C_RESET=
fi
say()  { printf '%s▸%s %s\n' "$C_BLUE"   "$C_RESET" "$*"; }
ok()   { printf '%s✓%s %s\n' "$C_GREEN"  "$C_RESET" "$*"; }
warn() { printf '%s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
die()  { printf '%s✗%s %s\n' "$C_RED"    "$C_RESET" "$*" >&2; exit 1; }
hr()   { printf '%s%s%s\n' "$C_DIM" "──────────────────────────────────────────────────────────────────" "$C_RESET"; }
header() { printf '\n%s%s%s\n' "$C_CYAN$C_BOLD" "$*" "$C_RESET"; hr; }

# ── Package catalogue ─────────────────────────────────────────────────
# Format: "<npm-name>|<workspace-path>|<category>|<display-name>"
# Category: host = marketplace runtime, plugin = installable plugin,
#           core = reusable runtime library,
#           engine = platform-specific tunnel engine resource package,
#           tool = npm CLI/helper, game = installable game.
#
# When you add a new publishable package, add a row here. Anything not in
# this list won't show up in `status` / `prepare-*` menus.
PACKAGES=(
  "@qpjoy/electron-plugin-sdk|electron-market/packages/electron-plugin-sdk|host|Plugin SDK (类型定义)"
  "@qpjoy/marketplace-db|electron-market/packages/marketplace-db|host|Marketplace DB (SQLite 层)"
  "@qpjoy/electron-market|electron-market/packages/electron-market|host|Electron Market (宿主运行时)"
  "@qpjoy/electron-launcher|electron-dock/mx-launcher/packages/electron-launcher|host|Electron Launcher (产品接入客户端)"
  "@qpjoy/electron-core-mihomo|electron-plugin/packages/electron-core-mihomo|core|Electron Core Mihomo (路由编译层)"
  "@qpjoy/electron-core-wireguard|electron-plugin/packages/electron-core-wireguard|core|Electron Core WireGuard (HDI mesh 配置层)"
  "@qpjoy/mx-launcher-core|electron-dock/mx-launcher/packages/launcher-core|core|MX Launcher Core (Internal API + route plan)"
  "@qpjoy/mx-launcher-embed-sdk|electron-dock/mx-launcher/packages/launcher-embed-sdk|core|MX Launcher Embed SDK"
  "@qpjoy/mx-launcher-standalone|electron-dock/mx-launcher/packages/launcher-standalone|core|MX Launcher Standalone adapter"
  "@qpjoy/electron-plugin-tunnel-engine-darwin-arm64|electron-plugin/packages/tunnel-engines/darwin-arm64|engine|Tunnel Engine macOS arm64"
  "@qpjoy/electron-plugin-tunnel-engine-darwin-x64|electron-plugin/packages/tunnel-engines/darwin-x64|engine|Tunnel Engine macOS x64"
  "@qpjoy/electron-plugin-tunnel-engine-linux-arm64|electron-plugin/packages/tunnel-engines/linux-arm64|engine|Tunnel Engine Linux arm64"
  "@qpjoy/electron-plugin-tunnel-engine-linux-x64|electron-plugin/packages/tunnel-engines/linux-x64|engine|Tunnel Engine Linux x64"
  "@qpjoy/electron-plugin-tunnel-engine-win32-x64|electron-plugin/packages/tunnel-engines/win32-x64|engine|Tunnel Engine Windows x64"
  "@qpjoy/electron-core-wireguard-engine-darwin-arm64|electron-plugin/packages/wireguard-engines/darwin-arm64|engine|WireGuard Engine macOS arm64"
  "@qpjoy/electron-core-wireguard-engine-darwin-x64|electron-plugin/packages/wireguard-engines/darwin-x64|engine|WireGuard Engine macOS x64"
  "@qpjoy/electron-core-wireguard-engine-linux-arm64|electron-plugin/packages/wireguard-engines/linux-arm64|engine|WireGuard Engine Linux arm64"
  "@qpjoy/electron-core-wireguard-engine-linux-x64|electron-plugin/packages/wireguard-engines/linux-x64|engine|WireGuard Engine Linux x64"
  "@qpjoy/electron-core-wireguard-engine-win32-x64|electron-plugin/packages/wireguard-engines/win32-x64|engine|WireGuard Engine Windows x64"
  "@qpjoy/electron-plugin-tunnel|electron-plugin/packages/electron-plugin-tunnel|plugin|QPJoy Tunnel"
  "@qpjoy/electron-plugin-hdo|electron-plugin/packages/electron-plugin-hdo|plugin|QPJoy HDO"
  "@qpjoy/electron-plugin-notyet|electron-plugin/packages/electron-plugin-notyet|plugin|NotYet 悬浮咨询球"
  "@qpjoy/tunnel-cli|electron-plugin/packages/tunnel-cli|tool|Tunnel CLI (服务器脚本分发器)"
  "@qpjoy/electron-game-suduku|electron-game/games/suduku|game|Suduku 数独游戏"
)

# Filter PACKAGES by category. Outputs each matching row.
pkgs_by_category() {
  local want="$1"
  for row in "${PACKAGES[@]}"; do
    IFS='|' read -r _name _path cat _label <<<"$row"
    [ "$cat" = "$want" ] && echo "$row"
  done
}

pkg_field() {
  # $1=row, $2=field-index (1-based)
  local row="$1" idx="$2"
  IFS='|' read -r f1 f2 f3 f4 <<<"$row"
  case "$idx" in 1) echo "$f1";; 2) echo "$f2";; 3) echo "$f3";; 4) echo "$f4";; esac
}

# ── Package introspection ─────────────────────────────────────────────

pkg_local_version() {
  local pkg_path="$1"
  if [ -f "$ROOT/$pkg_path/package.json" ]; then
    node -p "require('$ROOT/$pkg_path/package.json').version" 2>/dev/null || echo "?"
  else
    echo "MISSING"
  fi
}

# Note: macOS ships bash 3.2 which has no associative arrays, so we don't
# cache npm view results. For ~5 packages × ~1s each this is fine.
pkg_npm_version() {
  local name="$1"
  local v
  # `npm view ... version` exits non-zero if the package doesn't exist yet.
  # We treat that as "unpublished" instead of an error.
  if v=$(npm_config_fetch_retries=0 npm_config_fetch_timeout=5000 npm view "$name" version 2>/dev/null); then
    echo "$v"
  else
    echo "(unpublished)"
  fi
}

# Compare two semver strings. Echo: equal | local-newer | npm-newer | unknown
semver_cmp() {
  local a="$1" b="$2"
  if [ "$a" = "$b" ]; then echo equal; return; fi
  if [ "$b" = "(unpublished)" ]; then echo local-newer; return; fi
  # Use node's semver-like compare via numeric tuple
  local cmp
  cmp=$(node -e "
    const a='$a'.split('.').map(Number), b='$b'.split('.').map(Number);
    for (let i=0;i<3;i++){
      if ((a[i]||0)>(b[i]||0)) {console.log('local-newer'); process.exit(0)}
      if ((a[i]||0)<(b[i]||0)) {console.log('npm-newer');   process.exit(0)}
    }
    console.log('equal');
  " 2>/dev/null) || cmp=unknown
  echo "$cmp"
}

pkg_status_line() {
  local row="$1"
  local name path cat label local_v npm_v cmp icon hint
  name=$(pkg_field "$row" 1)
  path=$(pkg_field "$row" 2)
  cat=$(pkg_field  "$row" 3)
  label=$(pkg_field "$row" 4)
  local_v=$(pkg_local_version "$path")
  npm_v=$(pkg_npm_version "$name")
  cmp=$(semver_cmp "$local_v" "$npm_v")
  case "$cmp" in
    equal)        icon="${C_GREEN}✓${C_RESET}"; hint="${C_DIM}已同步${C_RESET}";;
    local-newer)  icon="${C_YELLOW}↑${C_RESET}"; hint="${C_YELLOW}需发布${C_RESET}";;
    npm-newer)    icon="${C_RED}↓${C_RESET}"; hint="${C_RED}本地落后${C_RESET}";;
    *)            icon="${C_DIM}?${C_RESET}"; hint="${C_DIM}—${C_RESET}";;
  esac
  printf '  %s %-32s  %s%-10s%s  %s%-12s%s  %s\n' \
    "$icon" "$name" "$C_BOLD" "$local_v" "$C_RESET" "$C_DIM" "→ $npm_v" "$C_RESET" "$hint"
}

# ── Commands ──────────────────────────────────────────────────────────

cmd_status() {
  header "Server 状态"
  if [ -f "$ROOT/electron-server/docker-compose.yml" ]; then
    if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
      (cd "$ROOT/electron-server" && docker compose -f docker-compose.yml ps 2>/dev/null || warn "docker compose 失败")
    elif command -v docker-compose >/dev/null 2>&1 && docker-compose version >/dev/null 2>&1; then
      (cd "$ROOT/electron-server" && docker-compose -f docker-compose.yml ps 2>/dev/null || warn "docker-compose 失败")
    else
      warn "docker compose / docker-compose 未安装，跳过 server 状态"
    fi
  else
    warn "未找到 electron-server/docker-compose.yml"
  fi

  header "市场宿主组件 (host stack)"
  printf '  %-2s %-32s  %-10s  %-12s  %s\n' "" "包名" "本地" "npm" "状态"
  while IFS= read -r row; do pkg_status_line "$row"; done < <(pkgs_by_category host)

  header "公共网络底座 (core libraries)"
  while IFS= read -r row; do pkg_status_line "$row"; done < <(pkgs_by_category core)

  header "市场上架插件 (plugins)"
  while IFS= read -r row; do pkg_status_line "$row"; done < <(pkgs_by_category plugin)

  header "平台引擎资源包 (platform engines)"
  while IFS= read -r row; do pkg_status_line "$row"; done < <(pkgs_by_category engine)

  header "命令行工具 (tools)"
  while IFS= read -r row; do pkg_status_line "$row"; done < <(pkgs_by_category tool)

  local game_rows
  game_rows=$(pkgs_by_category game)
  if [ -n "$game_rows" ]; then
    header "市场上架游戏 (games)"
    while IFS= read -r row; do pkg_status_line "$row"; done <<<"$game_rows"
  fi

  echo
  echo "${C_DIM}Tip: 'prepare-host' / 'prepare-core' / 'prepare-plugin' / 'prepare-engine' / 'prepare-tool' / 'prepare-game' 准备发布；'sync-apps' 让 demo/test 用上本地最新包${C_RESET}"
}

cmd_market() {
  local idx_path="$ROOT/electron-market/registry/index.json"
  if [ ! -f "$idx_path" ]; then
    die "未找到 $idx_path"
  fi
  header "市场内置目录 (打包进 electron-market 的 seed-index)"
  node -e "
    const idx = require('$idx_path');
    const cli = (s, c) => c==='dim'  ? '\\x1b[2m'+s+'\\x1b[0m'
                       : c==='ok'   ? '\\x1b[1;32m'+s+'\\x1b[0m'
                       : c==='bold' ? '\\x1b[1m'+s+'\\x1b[0m'
                       : c==='cyan' ? '\\x1b[1;36m'+s+'\\x1b[0m'
                       : s;
    console.log(cli('generatedAt: ', 'dim') + idx.generatedAt);
    console.log();
    for (const e of (idx.entries || [])) {
      const badges = [];
      if (e.verified)  badges.push(cli('✓ 官方',   'ok'));
      if (e.bootstrap) badges.push(cli('bootstrap','cyan'));
      console.log(cli(e.name, 'bold') + '  ' + badges.join(' '));
      console.log('  ' + cli(e.npm + '@' + e.latest, 'dim'));
      if (e.description) console.log('  ' + e.description.replace(/\\\\n/g, '\\n  '));
      if (e.homepage)    console.log('  ' + cli('主页: '+e.homepage, 'dim'));
      console.log();
    }
  "
  echo "${C_DIM}—— 上面卡片来自 registry/index.json；npm 服务端 sync 后会用真实 latest 覆盖${C_RESET}"
}

prompt_secret() {
  local prompt="$1" value
  if [ -t 0 ]; then
    read -r -s -p "$prompt" value
    echo >&2
  else
    read -r -p "$prompt" value
  fi
  printf '%s' "$value"
}

publish_one_with_otp() {
  local name="$1" path="$2" otp="$3"
  local login_choice login_otp

  if ! npm whoami >/dev/null 2>&1; then
    warn "当前 npm CLI 未登录；直接 publish 会失败。"
    warn "如果账号开启 2FA，npm login 也需要一次 OTP。"
    read -r -p "现在执行 npm login？[y/N] " login_choice
    case "$login_choice" in
      y|Y|yes|YES)
        login_otp="$(prompt_secret "npm login OTP（回车 = 复用刚输入的发布 OTP）: ")"
        [ -n "$login_otp" ] || login_otp="$otp"
        say "npm login"
        if ! (cd "$ROOT/$path" && npm login --auth-type=legacy --otp="$login_otp"); then
          warn "npm login 失败，已跳过自动发布。请确认账号、OTP、registry 后手动运行上面的 publish 命令。"
          return 1
        fi
        ;;
      *)
        warn "已跳过自动发布。请先 npm login，再手动运行上面的 publish 命令。"
        return 1
        ;;
    esac
  fi

  say "publish: pnpm publish --no-git-checks --otp=******"
  if (cd "$ROOT/$path" && pnpm publish --no-git-checks --otp="$otp"); then
    ok "发布完成: $name"
    return 0
  fi

  warn "发布失败。常见原因：OTP 过期、npm 未登录、账号没有 $name 的发布权限，或 registry 配置不对。"
  warn "可以重新运行 prepare，或手动执行上面打印的 publish 命令。"
  return 1
}

hdo_demo_tracks_package() {
  case "$1" in
    @qpjoy/electron-plugin-sdk|@qpjoy/marketplace-db|@qpjoy/electron-market|@qpjoy/electron-launcher|@qpjoy/mx-launcher-core|@qpjoy/mx-launcher-embed-sdk|@qpjoy/mx-launcher-standalone|@qpjoy/electron-core-mihomo|@qpjoy/electron-core-wireguard|@qpjoy/electron-plugin-tunnel|@qpjoy/electron-plugin-hdo|@qpjoy/electron-plugin-tunnel-engine-*|@qpjoy/electron-core-wireguard-engine-*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

hdo_demo_direct_dep_path() {
  case "$1" in
    @qpjoy/electron-market) echo "electron-market/packages/electron-market";;
    @qpjoy/electron-launcher) echo "electron-dock/mx-launcher/packages/electron-launcher";;
    @qpjoy/electron-plugin-sdk) echo "electron-market/packages/electron-plugin-sdk";;
    @qpjoy/electron-plugin-hdo) echo "electron-plugin/packages/electron-plugin-hdo";;
    @qpjoy/electron-plugin-tunnel) echo "electron-plugin/packages/electron-plugin-tunnel";;
    *) return 1;;
  esac
}

set_hdo_demo_direct_dep() {
  local name="$1" version="$2"
  node - "$ROOT/electron-demo/hdo/package.json" "$name" "^$version" <<'NODE'
const fs = require('fs');
const [pkgPath, name, spec] = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.dependencies = pkg.dependencies || {};
pkg.dependencies[name] = spec;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
NODE
}

sync_published_hdo_demo_direct_deps() {
  local name path local_v npm_v target_v
  for name in \
    @qpjoy/electron-market \
    @qpjoy/electron-launcher \
    @qpjoy/electron-plugin-sdk \
    @qpjoy/electron-plugin-hdo \
    @qpjoy/electron-plugin-tunnel
  do
    path=$(hdo_demo_direct_dep_path "$name") || continue
    local_v=$(pkg_local_version "$path")
    if npm_config_fetch_retries=0 npm_config_fetch_timeout=5000 npm view "$name@$local_v" version >/dev/null 2>&1; then
      target_v="$local_v"
    else
      if npm_v=$(npm_config_fetch_retries=0 npm_config_fetch_timeout=5000 npm view "$name" version 2>/dev/null); then
        target_v="$npm_v"
        warn "$name@$local_v 尚未能从 npm 确认，electron-demo/hdo 改用 npm latest: $npm_v"
      else
        warn "$name@$local_v 尚未能从 npm 确认，且无法读取 npm latest，保留 electron-demo/hdo 当前依赖"
        continue
      fi
    fi
    set_hdo_demo_direct_dep "$name" "$target_v"
    ok "electron-demo/hdo dependency: $name@^$target_v"
  done
}

sync_hdo_demo_npm_mode() {
  local published_name="${1:-}" published_version="${2:-}"
  if [ ! -f "$ROOT/electron-demo/hdo/scripts/dev-mode.mjs" ]; then
    warn "electron-demo/hdo/scripts/dev-mode.mjs 不存在，跳过 HDO demo npm 同步"
    return 1
  fi
  if [ -n "$published_name" ] && hdo_demo_direct_dep_path "$published_name" >/dev/null 2>&1; then
    set_hdo_demo_direct_dep "$published_name" "$published_version"
    ok "electron-demo/hdo dependency: $published_name@^$published_version"
  fi
  sync_published_hdo_demo_direct_deps
  say "electron-demo/hdo: 切到 npm mode 并刷新 lockfile"
  (cd "$ROOT/electron-demo/hdo" && node scripts/dev-mode.mjs npm --force)
}

sync_tunnel_cli_mx_launcher_fallback() {
  local name="$1" path="$2" tarball="$3"
  [ "$name" = "@qpjoy/tunnel-cli" ] || return 0
  local sync_script="$ROOT/$path/scripts/sync-mx-launcher-fallback.mjs"
  [ -f "$sync_script" ] || die "未找到 tunnel-cli fallback 同步脚本: $sync_script"
  [ -f "$tarball" ] || die "未找到 @qpjoy/tunnel-cli pack tarball: $tarball"
  say "sync: @qpjoy/tunnel-cli tarball -> mx-launcher Domestic fallback"
  node "$sync_script" --from-tarball "$tarball"
  ok "mx-launcher Domestic fallback 已同步: $tarball"
}

cmd_sync_hdo_npm() {
  header "把 electron-demo/hdo 同步到已发布 npm 包"
  sync_hdo_demo_npm_mode
  ok "electron-demo/hdo npm 依赖同步完成"
}

# Common preparation step: build a single workspace package and pack a
# tarball into /tmp/qpjoy-publish-preview/ for inspection.
prepare_one() {
  local row="$1"
  local name path label
  name=$(pkg_field "$row" 1)
  path=$(pkg_field "$row" 2)
  label=$(pkg_field "$row" 4)
  local preview_dir="/tmp/qpjoy-publish-preview"
  local preview_tgz

  header "准备发布: $name  (${label})"
  echo "  本地路径: $path"
  echo "  本地版本: $(pkg_local_version "$path")"
  echo "  npm 版本:  $(pkg_npm_version "$name")"
  if [ "$name" = "@qpjoy/electron-launcher" ]; then
    echo "  ${C_YELLOW}发布前置:${C_RESET} 先发布 @qpjoy/mx-launcher-core / @qpjoy/mx-launcher-embed-sdk / @qpjoy/mx-launcher-standalone 的同版本"
  fi
  echo

  read -r -p "新版本号 (回车 = 跳过 bump，直接打包当前版本): " new_ver
  if [ -n "$new_ver" ]; then
    if [[ ! "$new_ver" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]]; then
      die "版本号格式不对（期望 x.y.z 或 x.y.z-tag）"
    fi
    say "bump $name → $new_ver"
    node -e "
      const fs = require('fs');
      const p = '$ROOT/$path/package.json';
      const pkg = JSON.parse(fs.readFileSync(p,'utf8'));
      pkg.version = '$new_ver';
      fs.writeFileSync(p, JSON.stringify(pkg,null,2)+'\n');
    "
    # plugin.manifest.json — many plugins have a sibling manifest with its
    # own version. Sync it if present. Build script usually handles this,
    # but writing it now keeps the diff clean before the build runs.
    local mf="$ROOT/$path/src/plugin.manifest.json"
    if [ -f "$mf" ]; then
      node -e "
        const fs = require('fs');
        const m = JSON.parse(fs.readFileSync('$mf','utf8'));
        m.version = '$new_ver';
        fs.writeFileSync('$mf', JSON.stringify(m,null,2)+'\n');
      "
      ok "同步了 src/plugin.manifest.json 版本"
    fi
    local game_mf="$ROOT/$path/src/game.manifest.json"
    if [ -f "$game_mf" ]; then
      node -e "
        const fs = require('fs');
        const m = JSON.parse(fs.readFileSync('$game_mf','utf8'));
        m.version = '$new_ver';
        fs.writeFileSync('$game_mf', JSON.stringify(m,null,2)+'\n');
      "
      ok "同步了 src/game.manifest.json 版本"
    fi
    ok "package.json 版本已更新"
  fi

  say "build: pnpm --filter $name build"
  (cd "$ROOT/$path/.." && pnpm --filter "$name" build) || die "build 失败"

  say "pack 预览到 /tmp/qpjoy-publish-preview/"
  rm -rf "$preview_dir"
  mkdir -p "$preview_dir"
  (cd "$ROOT/$path" && pnpm pack --pack-destination "$preview_dir")
  preview_tgz="$(find "$preview_dir" -maxdepth 1 -type f -name '*.tgz' | sort | tail -n 1)"
  [ -n "$preview_tgz" ] || die "pack 未生成 tgz: $preview_dir"
  sync_tunnel_cli_mx_launcher_fallback "$name" "$path" "$preview_tgz"

  echo
  ok "准备完成"
  echo
  echo "${C_BOLD}下一步（手动 OTP 后发布）：${C_RESET}"
  echo
  echo "  cd $ROOT/$path"
  echo "  pnpm publish --no-git-checks --otp=${C_DIM}<authenticator 6 位>${C_RESET}"
  echo
  echo "${C_DIM}发布成功后可选：${C_RESET}"
  echo "${C_DIM}  - 更新 electron-market/registry/index.json 里这个包的 latest / versions${C_RESET}"
  echo "${C_DIM}  - 重新 build electron-market 让 seed-index 同步：${C_RESET}"
  echo "${C_DIM}    pnpm --filter @qpjoy/electron-market build${C_RESET}"
  echo "${C_DIM}  - 同步到 demo / test 测试：scripts/manage.sh sync-apps${C_RESET}"
  if hdo_demo_tracks_package "$name"; then
    echo "${C_DIM}  - 发布到 npm 后刷新正式 HDO demo 依赖：scripts/manage.sh sync-hdo-npm${C_RESET}"
  fi
  if [ "$name" = "@qpjoy/tunnel-cli" ]; then
    echo "${C_DIM}  - @qpjoy/tunnel-cli tarball 已同步到 mx-launcher Domestic fallback${C_RESET}"
  fi

  echo
  local publish_otp
  publish_otp="$(prompt_secret "输入 npm OTP 直接发布（回车 = 只保留手动步骤）: ")"
  if [ -n "$publish_otp" ]; then
    if publish_one_with_otp "$name" "$path" "$publish_otp"; then
      if hdo_demo_tracks_package "$name"; then
        sync_hdo_demo_npm_mode "$name" "$(pkg_local_version "$path")" || warn "electron-demo/hdo npm 同步失败；包发布成功后可手动运行 scripts/manage.sh sync-hdo-npm"
      fi
    fi
  else
    echo "${C_DIM}已跳过自动发布，保留上面的手动发布命令。${C_RESET}"
    if hdo_demo_tracks_package "$name"; then
      echo "${C_DIM}手动发布成功后运行：scripts/manage.sh sync-hdo-npm${C_RESET}"
    fi
    if [ "$name" = "@qpjoy/tunnel-cli" ]; then
      echo "${C_DIM}@qpjoy/tunnel-cli 的本次 pack tarball 已同步；若手动发布前重新打包，请再运行 scripts/manage.sh prepare-tool${C_RESET}"
    fi
  fi
}

pick_pkg_then_prepare() {
  local cat="$1" label="$2"
  local rows=()
  while IFS= read -r row; do rows+=("$row"); done < <(pkgs_by_category "$cat")
  if [ "${#rows[@]}" -eq 0 ]; then
    warn "$label 类别下还没有包"
    return
  fi
  # NOTE: `${label}` braces are mandatory here — bash on macOS (3.2) merges
  # the bytes of the following fullwidth colon (U+FF1A, "：") into the
  # variable name otherwise, producing a misleading "unbound variable" error.
  echo "${C_BOLD}选择要准备发布的${label}：${C_RESET}"
  local i=1
  for r in "${rows[@]}"; do
    local n l v
    n=$(pkg_field "$r" 1); l=$(pkg_field "$r" 4); v=$(pkg_local_version "$(pkg_field "$r" 2)")
    printf '  %d) %-32s  %s%s%s  %s\n' "$i" "$n" "$C_DIM" "(本地 $v)" "$C_RESET" "$l"
    ((i++))
  done
  echo "  q) 取消"
  read -r -p "选择 [1-${#rows[@]}/q] > " choice
  case "$choice" in
    q|Q|"") return;;
    [1-9]|[1-9][0-9])
      local idx=$((choice - 1))
      [ "$idx" -ge 0 ] && [ "$idx" -lt "${#rows[@]}" ] || die "序号越界"
      prepare_one "${rows[$idx]}"
      ;;
    *) die "无效输入";;
  esac
}

cmd_prepare_plugin() { pick_pkg_then_prepare plugin "插件"; }
cmd_prepare_core()   { pick_pkg_then_prepare core   "公共网络底座"; }
cmd_prepare_engine() { pick_pkg_then_prepare engine "引擎资源包"; }
cmd_prepare_host()   { pick_pkg_then_prepare host   "宿主组件"; }
cmd_prepare_tool()   { pick_pkg_then_prepare tool   "命令行工具"; }
cmd_prepare_game()   { pick_pkg_then_prepare game   "游戏"; }

cmd_sync_apps() {
  header "把 electron-demo/hdo / electron-test 同步到本地最新包"
  # electron-demo/tunnel intentionally stays on published npm packages so it
  # keeps testing the pre-HDO tunnel consumer flow. electron-demo/hdo links the
  # current local HDO/market packages and is the app that should follow local
  # HDO work.
  if [ -f "$ROOT/electron-demo/hdo/scripts/dev-mode.mjs" ]; then
    say "electron-demo/hdo: dev-mode local (force re-pack)"
    (cd "$ROOT/electron-demo/hdo" && node scripts/dev-mode.mjs local --force) || warn "electron-demo/hdo dev-mode local 失败"
  else
    warn "electron-demo/hdo/scripts/dev-mode.mjs 不存在，跳过"
  fi
  if [ -f "$ROOT/electron-demo/tunnel/package.json" ]; then
    ok "electron-demo/tunnel 保持发布版 npm 依赖，不自动切到本地 file: refs"
  fi
  if [ -f "$ROOT/electron-test/scripts/dev-mode.mjs" ]; then
    say "electron-test: dev-mode local (force re-pack)"
    rm -f "$ROOT/electron-test/.dev-mode"
    (cd "$ROOT/electron-test" && node scripts/dev-mode.mjs local) || warn "electron-test dev-mode 失败"
  else
    warn "electron-test/scripts/dev-mode.mjs 不存在，跳过"
  fi
  ok "测试 app 同步完成"
}

cmd_server() {
  local sub="${1:-}"
  if [ ! -f "$ROOT/electron-server/scripts/manage.sh" ]; then
    die "未找到 electron-server/scripts/manage.sh"
  fi
  if [ -z "$sub" ]; then
    "$ROOT/electron-server/scripts/manage.sh"
  else
    "$ROOT/electron-server/scripts/manage.sh" "$@"
  fi
}

cmd_hdo() {
  if [ ! -f "$ROOT/docker/hdo-gateway-stack/manage.sh" ]; then
    die "未找到 docker/hdo-gateway-stack/manage.sh"
  fi
  "$ROOT/docker/hdo-gateway-stack/manage.sh" "$@"
}

cmd_nuke() {
  cmd_server nuke "$@"
}

cmd_deploy() {
  local sub="${1:-}"
  if [ -n "$sub" ]; then
    shift || true
    case "$sub" in
      server|electron-server)
        cmd_server redeploy "$@"
        ;;
      hdo|hdo-domestic|domestic)
        cmd_hdo deploy-domestic "$@"
        ;;
      hdo-home|home-peer)
        cmd_hdo add-home "$@"
        ;;
      hdo-wireguard|wireguard|wg)
        cmd_hdo menu
        ;;
      *)
        die "未知 deploy 子命令: $sub"
        ;;
    esac
    return
  fi

  echo "${C_CYAN}${C_BOLD}QPJoy Deploy Manager${C_RESET}"
  echo
  local options=(
    "server        部署/重启 electron-server"
    "hdo          部署 HDO domestic + WireGuard"
    "hdo-home     生成 Home WireGuard peer"
    "hdo-wg       进入 HDO WireGuard 菜单"
    "status       查看状态"
    "quit         返回"
  )
  PS3=$'\n选择部署项 > '
  select opt in "${options[@]}"; do
    [ -z "$opt" ] && continue
    local cmd="${opt%% *}"
    case "$cmd" in
      server)   cmd_server redeploy ;;
      hdo)      cmd_hdo deploy-domestic ;;
      hdo-home) cmd_hdo add-home ;;
      hdo-wg)   cmd_hdo menu ;;
      status)   cmd_status ;;
      quit|exit) break ;;
      *) warn "未知选项";;
    esac
    echo
  done
}

cmd_help() {
  cat <<EOF
${C_BOLD}QPJoy Marketplace 管理脚本${C_RESET}

Usage:
  scripts/manage.sh [subcommand] [args...]

Subcommands:
  ${C_BOLD}status${C_RESET}            服务器 + 所有可发布包的本地/npm 版本一览
  ${C_BOLD}market${C_RESET}            浏览市场内置目录（seed-index 卡片）
  ${C_BOLD}prepare-plugin${C_RESET}    选择插件 → bump 版本 + build + pack 预览
  ${C_BOLD}prepare-core${C_RESET}      选择公共网络底座做同样操作
  ${C_BOLD}prepare-engine${C_RESET}    选择平台引擎资源包做同样操作
  ${C_BOLD}prepare-host${C_RESET}      选择宿主组件（electron-market 等）做同样操作
  ${C_BOLD}prepare-tool${C_RESET}      选择命令行工具做同样操作
  ${C_BOLD}prepare-game${C_RESET}      选择游戏 → bump 版本 + build + pack 预览
  ${C_BOLD}sync-apps${C_RESET}         同步 electron-demo / electron-test 到最新本地包
  ${C_BOLD}sync-hdo-npm${C_RESET}      把 electron-demo/hdo 切回已发布 npm 包并刷新 lockfile
  ${C_BOLD}deploy${C_RESET}            单独部署菜单（server / HDO domestic / WireGuard）
  ${C_BOLD}hdo-device-conflicts${C_RESET} 查看 HDO overlay IP 冲突
  ${C_BOLD}hdo-reset-devices${C_RESET}   清 HDO 设备态，默认保留 100.89.0.12
  ${C_BOLD}server [...] ${C_RESET}     转发到 electron-server/scripts/manage.sh
  ${C_BOLD}hdo [...] ${C_RESET}        转发到 docker/hdo-gateway-stack/manage.sh
  ${C_BOLD}nuke [...] ${C_RESET}       清空 server/HDO 生成状态，转发到 server nuke
  ${C_BOLD}help${C_RESET}              本帮助

Examples:
  scripts/manage.sh                       # 交互菜单
  scripts/manage.sh status
  scripts/manage.sh prepare-plugin
  scripts/manage.sh prepare-tool
  scripts/manage.sh deploy hdo
  scripts/manage.sh hdo-device-conflicts
  scripts/manage.sh hdo-reset-devices --keep-ip 100.89.0.12
  scripts/manage.sh server status
  scripts/manage.sh server sync
  sudo scripts/manage.sh nuke --all --yes
  scripts/manage.sh hdo setup-domestic --server-url http://domestic:8080 --public-host domestic.example.com

发布流程（每次手动 OTP）:
  1. scripts/manage.sh prepare-plugin     # 或 prepare-core / prepare-engine / prepare-host / prepare-tool / prepare-game
  2. 脚本会打印手动 publish 命令；也可输入 OTP 让脚本直接发布
     cd <package-dir> && pnpm publish --otp=XXXXXX --no-git-checks
  3. scripts/manage.sh sync-hdo-npm       # 发布后让 electron-demo/hdo 回到 npm 正式依赖
     scripts/manage.sh sync-apps          # （可选）让 demo/test 用本地开发包

EOF
}

cmd_menu() {
  echo "${C_CYAN}${C_BOLD}QPJoy Marketplace Manager${C_RESET}"
  echo
  local options=(
    "status         市场 + 包版本一览"
    "market         查看市场卡片列表 (seed-index)"
    "prepare-plugin 准备发布: 插件"
    "prepare-core   准备发布: 公共网络底座"
    "prepare-engine 准备发布: Tunnel 引擎资源包"
    "prepare-host   准备发布: 市场宿主组件"
    "prepare-tool   准备发布: 命令行工具"
    "prepare-game   准备发布: 游戏"
    "sync-apps      同步 demo/test 到本地最新包"
    "sync-hdo-npm   同步 HDO demo 到已发布 npm 包"
    "deploy         部署 server / HDO / WireGuard"
    "hdo-ip         查看 HDO IP 冲突"
    "hdo-reset      清 HDO 设备态（保留 Internal）"
    "server         进入服务器 (docker) 管理菜单"
    "hdo            HDO gateway 安装/配置"
    "nuke           清空 server/HDO 生成状态"
    "help           帮助"
    "quit           退出"
  )
  PS3=$'\n选择操作 > '
  select opt in "${options[@]}"; do
    [ -z "$opt" ] && continue
    local cmd="${opt%% *}"
    case "$cmd" in
      status)         cmd_status ;;
      market)         cmd_market ;;
      prepare-plugin) cmd_prepare_plugin ;;
      prepare-core)   cmd_prepare_core ;;
      prepare-engine) cmd_prepare_engine ;;
      prepare-host)   cmd_prepare_host ;;
      prepare-tool)   cmd_prepare_tool ;;
      prepare-game)   cmd_prepare_game ;;
      sync-apps)      cmd_sync_apps ;;
      sync-hdo-npm)   cmd_sync_hdo_npm ;;
      deploy)         cmd_deploy ;;
      hdo-ip)         cmd_server hdo-device-conflicts ;;
      hdo-reset)      cmd_server hdo-reset-devices ;;
      server)         cmd_server ;;
      hdo)            cmd_hdo ;;
      nuke)           cmd_nuke ;;
      help)           cmd_help ;;
      quit|exit)      break ;;
      *) warn "未知选项";;
    esac
    echo
  done
}

# ── Dispatch ──────────────────────────────────────────────────────────
sub="${1:-menu}"
shift || true
case "$sub" in
  status|st)                    cmd_status "$@" ;;
  market|cards|catalog)         cmd_market "$@" ;;
  prepare-plugin|plugin)        cmd_prepare_plugin "$@" ;;
  prepare-core|core)            cmd_prepare_core "$@" ;;
  prepare-engine|engine)        cmd_prepare_engine "$@" ;;
  prepare-host|host)            cmd_prepare_host "$@" ;;
  prepare-tool|tool)            cmd_prepare_tool "$@" ;;
  prepare-game|game)            cmd_prepare_game "$@" ;;
  sync-apps|sync|apps)          cmd_sync_apps "$@" ;;
  sync-hdo-npm|hdo-npm)         cmd_sync_hdo_npm "$@" ;;
  deploy|deployment)            cmd_deploy "$@" ;;
  hdo-device-conflicts|hdo-conflicts|hdo-ip-conflicts) cmd_server hdo-device-conflicts "$@" ;;
  hdo-reset-devices|hdo-clean-devices|hdo-device-reset) cmd_server hdo-reset-devices "$@" ;;
  server|srv)                   cmd_server "$@" ;;
  hdo)                          cmd_hdo "$@" ;;
  nuke|wipe)                    cmd_nuke "$@" ;;
  help|-h|--help)               cmd_help ;;
  menu)                         cmd_menu ;;
  *) warn "未知命令: $sub"; cmd_help; exit 1 ;;
esac
