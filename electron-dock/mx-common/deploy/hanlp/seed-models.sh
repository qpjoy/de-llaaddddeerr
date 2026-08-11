#!/bin/sh
# Seed the dedicated runtime PVC from the model baked into the image. The
# checksum marker is written only after every file verifies, so an interrupted
# copy is repaired by the next initContainer run rather than mistaken for a
# complete cache. A changed seed replaces the old cache instead of accumulating
# stale model versions in the PVC.
set -eu

seed_dir="${HANLP_SEED_DIR:-/opt/hanlp-model-seed}"
models_dir="${HANLP_HOME:-/models}"
manifest="${seed_dir}/.mx-common-manifest.sha256"
marker="${models_dir}/.mx-common-seed-id"

checksum_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1"
  else
    shasum -a 256 "$1"
  fi
}

manifest_for_dir() {
  (
    cd "$1"
    LC_ALL=C find . -type f ! -name '.mx-common-*' -print \
      | LC_ALL=C sort \
      | while IFS= read -r file; do
          checksum_file "$file"
        done
  )
}

verify_manifest() {
  [ "$(manifest_for_dir "$models_dir")" = "$(cat "$manifest")" ]
}

[ -s "$manifest" ] || {
  printf 'HanLP image has no preloaded model manifest: %s\n' "$manifest" >&2
  exit 1
}

case "$models_dir" in
  ''|/) printf 'Refusing unsafe HANLP_HOME: %s\n' "$models_dir" >&2; exit 1 ;;
esac
[ "$models_dir" != "$seed_dir" ] || {
  printf 'HANLP_HOME and HANLP_SEED_DIR must be different\n' >&2
  exit 1
}

mkdir -p "$models_dir"
seed_id="v2-$(checksum_file "$manifest" | awk '{print $1}')"

if [ -f "$marker" ] \
  && [ "$(cat "$marker")" = "$seed_id" ] \
  && verify_manifest; then
  printf 'HanLP model cache is current (%s)\n' "$seed_id"
  exit 0
fi

printf 'Seeding HanLP model cache (%s)\n' "$seed_id"
# This PVC is exclusively owned by HanLP. Clear the prior desired state first;
# if the copy is interrupted, the missing marker makes the next init retry.
# Preserve filesystem recovery metadata sometimes created at a volume root.
find "$models_dir" -mindepth 1 -maxdepth 1 ! -name lost+found \
  -exec rm -rf -- {} +
cp -a "${seed_dir}/." "${models_dir}/"
verify_manifest

marker_tmp="${marker}.$$"
trap 'rm -f -- "$marker_tmp"' EXIT HUP INT TERM
printf '%s\n' "$seed_id" >"$marker_tmp"
mv -f "$marker_tmp" "$marker"
trap - EXIT HUP INT TERM
printf 'HanLP model cache seeded and verified\n'
