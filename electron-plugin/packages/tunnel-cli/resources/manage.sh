#!/usr/bin/env bash

set -Eeuo pipefail

QP_TUNNEL_NODE_VERSION="${QP_TUNNEL_NODE_VERSION:-22}"
QP_TUNNEL_CLI_SPEC="${QP_TUNNEL_CLI_SPEC:-@qpjoy/tunnel-cli@latest}"
QP_TUNNEL_NVM_VERSION="${QP_TUNNEL_NVM_VERSION:-v0.40.3}"
QP_TUNNEL_NVM_TARBALL_URL="${QP_TUNNEL_NVM_TARBALL_URL:-https://github.com/nvm-sh/nvm/archive/refs/tags/$QP_TUNNEL_NVM_VERSION.tar.gz}"
QP_TUNNEL_NVM_TARBALL_MIRRORS="${QP_TUNNEL_NVM_TARBALL_MIRRORS:-https://gitee.com/mirrors/nvm/repository/archive/$QP_TUNNEL_NVM_VERSION.tar.gz}"
QP_TUNNEL_NVM_TARBALL_URLS="${QP_TUNNEL_NVM_TARBALL_URLS:-}"
QP_TUNNEL_NODE_MIRROR="${QP_TUNNEL_NODE_MIRROR:-https://mirrors.cloud.tencent.com/nodejs-release/}"
QP_TUNNEL_NPM_REGISTRY="${QP_TUNNEL_NPM_REGISTRY:-https://registry.npmmirror.com}"
QP_TUNNEL_DOCKERHUB_MIRROR="${QP_TUNNEL_DOCKERHUB_MIRROR:-docker.m.daocloud.io}"
QP_TUNNEL_PROFILE_FILE="${QP_TUNNEL_PROFILE_FILE:-$HOME/.bashrc}"
NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

CURRENT_NODE_MIRROR="${NVM_NODEJS_ORG_MIRROR:-}"
CURRENT_NODE_SOURCE_LABEL="${CURRENT_NODE_SOURCE_LABEL:-official + Tencent fallback}"
CURRENT_NPM_REGISTRY="${npm_config_registry:-$QP_TUNNEL_NPM_REGISTRY}"
CURRENT_DOCKERHUB_MIRROR="$QP_TUNNEL_DOCKERHUB_MIRROR"
COMMON_MIRRORS_APPLIED="${COMMON_MIRRORS_APPLIED:-false}"

if [ -t 1 ]; then
	C_RED=$'\033[1;31m'; C_GREEN=$'\033[1;32m'; C_YELLOW=$'\033[1;33m'
	C_BLUE=$'\033[1;34m'; C_CYAN=$'\033[1;36m'; C_DIM=$'\033[2m'
	C_BOLD=$'\033[1m'; C_RESET=$'\033[0m'
else
	C_RED=; C_GREEN=; C_YELLOW=; C_BLUE=; C_CYAN=; C_DIM=; C_BOLD=; C_RESET=
fi

say() { printf '%s▸%s %s\n' "$C_BLUE" "$C_RESET" "$*"; }
ok() { printf '%s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '%s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
die() { printf '%s✗%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

usage() {
	cat <<EOF
QPJoy Tunnel CLI bootstrap

Usage:
  bash manage.sh                         # interactive panel
  bash manage.sh install-nvm
  bash manage.sh install-node [version]
  bash manage.sh install-cli [npm-package]
  bash manage.sh bootstrap [version] [npm-package]
  bash manage.sh env
  bash manage.sh help

Notes:
  Domestic mirrors are current-session environment only. This script does not
  write npm registry config or Docker daemon registry-mirrors globally.

Defaults:
  Node version:         $QP_TUNNEL_NODE_VERSION
  nvm fallback tarball: $QP_TUNNEL_NVM_TARBALL_MIRRORS
  Node fallback mirror: $QP_TUNNEL_NODE_MIRROR
  npm registry:         $QP_TUNNEL_NPM_REGISTRY
  Docker Hub mirror:    $QP_TUNNEL_DOCKERHUB_MIRROR
  Tunnel CLI package:   $QP_TUNNEL_CLI_SPEC
EOF
}

command_exists() {
	command -v "$1" >/dev/null 2>&1
}

download() {
	local source="$1"
	local output="$2"

	if [ -f "$source" ]; then
		cp "$source" "$output"
	elif command_exists curl; then
		curl -fsSL --connect-timeout 15 --max-time 180 "$source" -o "$output"
	elif command_exists wget; then
		wget -q "$source" -O "$output"
	else
		die "需要 curl 或 wget 下载 nvm/Node.js"
	fi
}

prompt_default() {
	local prompt="$1"
	local default_value="$2"
	local result

	read -r -p "$prompt [$default_value]: " result
	printf '%s' "${result:-$default_value}"
}

shell_quote() {
	printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

append_profile_line() {
	local line="$1"

	mkdir -p "$(dirname "$QP_TUNNEL_PROFILE_FILE")"
	touch "$QP_TUNNEL_PROFILE_FILE"
	if ! grep -Fqx "$line" "$QP_TUNNEL_PROFILE_FILE"; then
		printf '%s\n' "$line" >> "$QP_TUNNEL_PROFILE_FILE"
	fi
}

write_profile() {
	append_profile_line 'export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"'
	append_profile_line '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"'
	ok "nvm loading lines saved to $QP_TUNNEL_PROFILE_FILE"
}

load_nvm() {
	export NVM_DIR
	if [ -s "$NVM_DIR/nvm.sh" ]; then
		# shellcheck disable=SC1090
		. "$NVM_DIR/nvm.sh"
		return 0
	fi
	return 1
}

nvm_tarball_urls() {
	if [ -n "$QP_TUNNEL_NVM_TARBALL_URLS" ]; then
		printf '%s\n' "$QP_TUNNEL_NVM_TARBALL_URLS" | tr ', ' '\n\n' | awk 'NF && !seen[$0]++ { print }'
		return
	fi

	{
		printf '%s\n' "$QP_TUNNEL_NVM_TARBALL_URL"
		printf '%s\n' "$QP_TUNNEL_NVM_TARBALL_MIRRORS" | tr ', ' '\n\n'
	} | awk 'NF && !seen[$0]++ { print }'
}

install_nvm() {
	local archive
	local tmp_dir
	local source
	local installed="false"

	if load_nvm; then
		ok "nvm ready: $(nvm --version)"
		write_profile
		return
	fi

	command_exists tar || die "需要 tar 解压 nvm"
	archive="$(mktemp)"
	while IFS= read -r source; do
		[ -n "$source" ] || continue
		tmp_dir="$(mktemp -d)"
		rm -f "$archive"
		say "Downloading nvm $QP_TUNNEL_NVM_VERSION: $source"
		if download "$source" "$archive" && [ -s "$archive" ] && tar -xzf "$archive" -C "$tmp_dir" --strip-components 1 && [ -s "$tmp_dir/nvm.sh" ]; then
			mkdir -p "$NVM_DIR"
			cp -R "$tmp_dir"/. "$NVM_DIR"/
			installed="true"
			rm -rf "$tmp_dir"
			break
		fi
		warn "nvm source failed: $source"
		rm -rf "$tmp_dir"
	done < <(nvm_tarball_urls)
	rm -f "$archive"

	[ "$installed" = "true" ] || die "nvm 下载失败。可设置 QP_TUNNEL_NVM_TARBALL_URLS=/path/nvm.tar.gz 后重试。"
	load_nvm || die "nvm 安装后仍无法加载: $NVM_DIR/nvm.sh"
	write_profile
	ok "nvm installed: $(nvm --version)"
}

set_node_source() {
	local label="$1"
	local mirror="$2"

	CURRENT_NODE_SOURCE_LABEL="$label"
	CURRENT_NODE_MIRROR="$mirror"
	if [ -n "$mirror" ]; then
		export NVM_NODEJS_ORG_MIRROR="$mirror"
	else
		unset NVM_NODEJS_ORG_MIRROR || true
	fi
	ok "Node source for this manage session: $label"
}

choose_node_source() {
	echo "${C_BOLD}选择 Node 下载源（仅当前 manage 会话）:${C_RESET}"
	echo "  1) official + Tencent fallback"
	echo "  2) Tencent cloud mirror"
	echo "  3) npmmirror"
	echo "  4) Huawei cloud mirror"
	echo "  5) custom"
	echo "  q) cancel"
	read -r -p "选择 [1-5/q] > " choice
	case "$choice" in
		1) set_node_source "official + Tencent fallback" "" ;;
		2) set_node_source "Tencent cloud" "https://mirrors.cloud.tencent.com/nodejs-release/" ;;
		3) set_node_source "npmmirror" "https://npmmirror.com/mirrors/node/" ;;
		4) set_node_source "Huawei cloud" "https://repo.huaweicloud.com/nodejs/" ;;
		5)
			local custom
			custom="$(prompt_default "Node mirror URL" "$QP_TUNNEL_NODE_MIRROR")"
			set_node_source "custom" "$custom"
			;;
		q|Q|"") return ;;
		*) warn "未知选择: $choice" ;;
	esac
}

install_node() {
	local version="$1"

	install_nvm
	if [ -n "$CURRENT_NODE_MIRROR" ]; then
		say "nvm install $version ($CURRENT_NODE_SOURCE_LABEL)"
		NVM_NODEJS_ORG_MIRROR="$CURRENT_NODE_MIRROR" nvm install "$version" || die "Node $version 安装失败"
	else
		say "nvm install $version (official Node source first)"
		if ! nvm install "$version"; then
			warn "Official Node source failed; retrying Tencent mirror: $QP_TUNNEL_NODE_MIRROR"
			NVM_NODEJS_ORG_MIRROR="$QP_TUNNEL_NODE_MIRROR" nvm install "$version" || die "Node $version 安装失败"
		fi
	fi

	nvm alias default "$version" >/dev/null
	nvm use "$version" >/dev/null
	ok "Node ready: $(node -v)"
}

set_npm_registry() {
	local label="$1"
	local registry="$2"

	CURRENT_NPM_REGISTRY="$registry"
	if [ -n "$registry" ]; then
		export npm_config_registry="$registry"
		export NPM_CONFIG_REGISTRY="$registry"
	else
		unset npm_config_registry NPM_CONFIG_REGISTRY || true
	fi
	ok "npm registry for this manage session: ${label:-official}"
}

choose_npm_registry() {
	echo "${C_BOLD}选择 npm registry（仅当前 manage 会话）:${C_RESET}"
	echo "  1) npmmirror"
	echo "  2) Tencent cloud"
	echo "  3) Huawei cloud"
	echo "  4) official npmjs"
	echo "  5) custom"
	echo "  q) cancel"
	read -r -p "选择 [1-5/q] > " choice
	case "$choice" in
		1) set_npm_registry "npmmirror" "https://registry.npmmirror.com" ;;
		2) set_npm_registry "Tencent cloud" "https://mirrors.cloud.tencent.com/npm/" ;;
		3) set_npm_registry "Huawei cloud" "https://repo.huaweicloud.com/repository/npm/" ;;
		4) set_npm_registry "official npmjs" "" ;;
		5)
			local custom
			custom="$(prompt_default "npm registry URL" "$QP_TUNNEL_NPM_REGISTRY")"
			set_npm_registry "custom" "$custom"
			;;
		q|Q|"") return ;;
		*) warn "未知选择: $choice" ;;
	esac
}

apply_npm_registry() {
	if [ -n "$CURRENT_NPM_REGISTRY" ]; then
		export npm_config_registry="$CURRENT_NPM_REGISTRY"
		export NPM_CONFIG_REGISTRY="$CURRENT_NPM_REGISTRY"
	fi
}

install_tunnel_cli() {
	local spec="$1"

	apply_npm_registry
	if ! command_exists npm; then
		load_nvm || die "npm not found. 请先安装 Node。"
	fi
	command_exists npm || die "npm not found. 请先安装 Node。"
	say "npm i -g $spec --force"
	npm i -g "$spec" --force
	command_exists qp-tunnel-cli || die "qp-tunnel-cli was not found in PATH after npm install"
	ok "qp-tunnel-cli ready: $(command -v qp-tunnel-cli)"
}

set_docker_mirror() {
	local mirror="$1"

	CURRENT_DOCKERHUB_MIRROR="$mirror"
	export QP_TUNNEL_DOCKERHUB_MIRROR="$mirror"
	ok "Docker Hub mirror for this manage session: $mirror"
	warn "Docker daemon registry-mirrors 不能只靠当前 shell 生效；这里提供的是镜像前缀 helper，不改 /etc/docker/daemon.json。"
}

choose_docker_mirror() {
	echo "${C_BOLD}选择 Docker Hub 镜像前缀（仅当前 manage helper 使用）:${C_RESET}"
	echo "  1) DaoCloud mirror"
	echo "  2) dockerproxy"
	echo "  3) custom"
	echo "  q) cancel"
	read -r -p "选择 [1-3/q] > " choice
	case "$choice" in
		1) set_docker_mirror "docker.m.daocloud.io" ;;
		2) set_docker_mirror "dockerproxy.net" ;;
		3)
			local custom
			custom="$(prompt_default "Docker Hub mirror prefix" "$CURRENT_DOCKERHUB_MIRROR")"
			set_docker_mirror "$custom"
			;;
		q|Q|"") return ;;
		*) warn "未知选择: $choice" ;;
	esac
}

docker_image_has_registry() {
	local image="$1"
	local first="${image%%/*}"

	[[ "$image" == */* ]] || return 1
	[[ "$first" == *.* || "$first" == *:* || "$first" == "localhost" ]]
}

docker_mirror_image() {
	local image="$1"
	local name_tag="$image"

	if docker_image_has_registry "$image"; then
		printf '%s' "$image"
		return
	fi

	if [[ "$image" != */* ]]; then
		name_tag="library/$image"
	fi
	printf '%s/%s' "${CURRENT_DOCKERHUB_MIRROR%/}" "$name_tag"
}

docker_pull_with_mirror() {
	command_exists docker || die "docker not found"
	local image
	local mirrored
	image="$(prompt_default "Docker image" "alpine:latest")"
	mirrored="$(docker_mirror_image "$image")"
	say "docker pull $mirrored"
	docker pull "$mirrored"
	if [ "$mirrored" != "$image" ]; then
		say "docker tag $mirrored $image"
		docker tag "$mirrored" "$image"
	fi
	ok "Docker image ready: $image"
}

apply_common_mirrors() {
	set_npm_registry "npmmirror" "$QP_TUNNEL_NPM_REGISTRY"
	set_node_source "Tencent cloud" "$QP_TUNNEL_NODE_MIRROR"
	export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
	export ELECTRON_BUILDER_BINARIES_MIRROR="${ELECTRON_BUILDER_BINARIES_MIRROR:-https://npmmirror.com/mirrors/electron-builder-binaries/}"
	export PLAYWRIGHT_DOWNLOAD_HOST="${PLAYWRIGHT_DOWNLOAD_HOST:-https://npmmirror.com/mirrors/playwright}"
	export CYPRESS_DOWNLOAD_MIRROR="${CYPRESS_DOWNLOAD_MIRROR:-https://npmmirror.com/mirrors/cypress/}"
	export PUPPETEER_DOWNLOAD_BASE_URL="${PUPPETEER_DOWNLOAD_BASE_URL:-https://npmmirror.com/mirrors/chrome-for-testing}"
	export PIP_INDEX_URL="${PIP_INDEX_URL:-https://pypi.tuna.tsinghua.edu.cn/simple}"
	export UV_INDEX_URL="${UV_INDEX_URL:-https://pypi.tuna.tsinghua.edu.cn/simple}"
	export GOPROXY="${GOPROXY:-https://goproxy.cn,direct}"
	COMMON_MIRRORS_APPLIED="true"
	ok "常用国内源已应用到当前 manage 会话"
}

print_env_exports() {
	cat <<EOF
export NVM_DIR=$(shell_quote "$NVM_DIR")
export QP_TUNNEL_NVM_TARBALL_URLS=$(shell_quote "$QP_TUNNEL_NVM_TARBALL_URLS")
export QP_TUNNEL_NVM_TARBALL_MIRRORS=$(shell_quote "$QP_TUNNEL_NVM_TARBALL_MIRRORS")
export NVM_NODEJS_ORG_MIRROR=$(shell_quote "$CURRENT_NODE_MIRROR")
export npm_config_registry=$(shell_quote "$CURRENT_NPM_REGISTRY")
export NPM_CONFIG_REGISTRY=$(shell_quote "$CURRENT_NPM_REGISTRY")
export QP_TUNNEL_DOCKERHUB_MIRROR=$(shell_quote "$CURRENT_DOCKERHUB_MIRROR")
export ELECTRON_MIRROR=$(shell_quote "${ELECTRON_MIRROR:-}")
export ELECTRON_BUILDER_BINARIES_MIRROR=$(shell_quote "${ELECTRON_BUILDER_BINARIES_MIRROR:-}")
export PLAYWRIGHT_DOWNLOAD_HOST=$(shell_quote "${PLAYWRIGHT_DOWNLOAD_HOST:-}")
export CYPRESS_DOWNLOAD_MIRROR=$(shell_quote "${CYPRESS_DOWNLOAD_MIRROR:-}")
export PUPPETEER_DOWNLOAD_BASE_URL=$(shell_quote "${PUPPETEER_DOWNLOAD_BASE_URL:-}")
export PIP_INDEX_URL=$(shell_quote "${PIP_INDEX_URL:-}")
export UV_INDEX_URL=$(shell_quote "${UV_INDEX_URL:-}")
export GOPROXY=$(shell_quote "${GOPROXY:-}")
EOF
}

enter_env_shell() {
	local shell_path="${SHELL:-/bin/bash}"

	say "Entering child shell with current mirror env. exit 后返回原 shell。"
	print_env_exports
	"$shell_path"
}

status() {
	echo "${C_CYAN}${C_BOLD}QPJoy Tunnel CLI bootstrap${C_RESET}"
	echo "NVM_DIR: $NVM_DIR"
	if load_nvm; then
		ok "nvm: $(nvm --version)"
	else
		warn "nvm: not installed"
	fi
	if command_exists node; then
		ok "node: $(node -v)"
	else
		warn "node: not found"
	fi
	if command_exists npm; then
		ok "npm: $(npm -v)"
	else
		warn "npm: not found"
	fi
	if command_exists qp-tunnel-cli; then
		ok "qp-tunnel-cli: $(command -v qp-tunnel-cli)"
	else
		warn "qp-tunnel-cli: not found"
	fi
	echo "Node source: $CURRENT_NODE_SOURCE_LABEL ${CURRENT_NODE_MIRROR:+($CURRENT_NODE_MIRROR)}"
	echo "npm registry env: ${CURRENT_NPM_REGISTRY:-official npmjs}"
	echo "Docker Hub helper mirror: $CURRENT_DOCKERHUB_MIRROR"
	echo "Common mirrors applied: $COMMON_MIRRORS_APPLIED"
}

bootstrap() {
	local version="${1:-$QP_TUNNEL_NODE_VERSION}"
	local spec="${2:-$QP_TUNNEL_CLI_SPEC}"

	apply_common_mirrors
	install_nvm
	install_node "$version"
	install_tunnel_cli "$spec"
	ok "Bootstrap done. Next: qp-tunnel-cli install --url 'http://user:pass@host:3434/peer.yaml'"
}

interactive_menu() {
	while true; do
		echo
		echo "${C_CYAN}${C_BOLD}QPJoy Tunnel CLI bootstrap${C_RESET}"
		echo "  1) install-nvm       安装/加载 nvm"
		echo "  2) install-node      安装/切换 Node 版本"
		echo "  3) node-source       选择 Node 下载源（当前 manage 会话）"
		echo "  4) npm-source        选择 npm registry（当前 manage 会话）"
		echo "  5) docker-source     选择 Docker Hub 镜像前缀 + pull helper"
		echo "  6) common-sources    应用常用国内源 env（当前 manage 会话）"
		echo "  7) install-cli       npm i -g @qpjoy/tunnel-cli"
		echo "  8) bootstrap         常用源 + nvm + Node + tunnel-cli"
		echo "  9) status            查看当前状态和源配置"
		echo "  10) env              打印当前源 export"
		echo "  11) shell            进入带当前源 env 的子 shell"
		echo "  h) help"
		echo "  q) quit"
		read -r -p "选择操作 > " choice
		case "$choice" in
			1|install-nvm) install_nvm ;;
			2|install-node)
				local version
				version="$(prompt_default "Node version" "$QP_TUNNEL_NODE_VERSION")"
				install_node "$version"
				;;
			3|node-source) choose_node_source ;;
			4|npm-source) choose_npm_registry ;;
			5|docker-source)
				choose_docker_mirror
				read -r -p "现在用该镜像 helper 拉一个 Docker image? [y/N] " pull_now
				case "$pull_now" in y|Y|yes|YES) docker_pull_with_mirror ;; esac
				;;
			6|common-sources) apply_common_mirrors ;;
			7|install-cli)
				local spec
				spec="$(prompt_default "npm package" "$QP_TUNNEL_CLI_SPEC")"
				install_tunnel_cli "$spec"
				;;
			8|bootstrap)
				local version spec
				version="$(prompt_default "Node version" "$QP_TUNNEL_NODE_VERSION")"
				spec="$(prompt_default "npm package" "$QP_TUNNEL_CLI_SPEC")"
				bootstrap "$version" "$spec"
				;;
			9|status) status ;;
			10|env) print_env_exports ;;
			11|shell) enter_env_shell ;;
			h|H|help) usage ;;
			q|Q|quit|exit) return ;;
			*) warn "未知操作: $choice" ;;
		esac
	done
}

main() {
	local command="${1:-menu}"
	[ "$#" -gt 0 ] && shift || true
	case "$command" in
		menu) interactive_menu ;;
		install-nvm) install_nvm "$@" ;;
		install-node) install_node "${1:-$QP_TUNNEL_NODE_VERSION}" ;;
		node-source) choose_node_source ;;
		npm-source) choose_npm_registry ;;
		common-sources) apply_common_mirrors ;;
		install-cli) install_tunnel_cli "${1:-$QP_TUNNEL_CLI_SPEC}" ;;
		bootstrap) bootstrap "${1:-$QP_TUNNEL_NODE_VERSION}" "${2:-$QP_TUNNEL_CLI_SPEC}" ;;
		status) status ;;
		env) print_env_exports ;;
		shell) enter_env_shell ;;
		help|-h|--help) usage ;;
		*) die "未知命令: $command. Run: bash manage.sh help" ;;
	esac
}

main "$@"
