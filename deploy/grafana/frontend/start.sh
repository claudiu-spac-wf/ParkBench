#!/bin/sh
set -eu
# Customize the supported static root without editing the vendor image or bundles.
source_root=${GF_SERVER_STATIC_ROOT_PATH:-${GF_PATHS_HOME:-/usr/share/grafana}/public}
case "$source_root" in
  /*) ;;
  *) source_root="${GF_PATHS_HOME:-/usr/share/grafana}/$source_root" ;;
esac
public_root=$(mktemp -d "${TMPDIR:-/tmp}/parkbench-grafana-public.XXXXXX")
for asset in "$source_root"/*; do
  if [ "${asset##*/}" = views ]; then
    cp -R "$asset" "$public_root/views"
  else
    ln -s "$asset" "$public_root/${asset##*/}"
  fi
done
if ! grep -q '</head>' "$source_root/views/index.html"; then
  echo 'parkbench_grafana_template_incompatible: missing closing head' >&2
  exit 1
fi
sed '/<\/head>/i\    <link rel="stylesheet" href="public/parkbench-chart-layout.css" />\n    <script src="public/parkbench-notice-status.js"></script>' \
  "$source_root/views/index.html" > "$public_root/views/index.html"
cp "$(dirname "$0")/chart-layout.css" "$public_root/parkbench-chart-layout.css"
cp "$(dirname "$0")/notice-status.js" "$public_root/parkbench-notice-status.js"
export GF_SERVER_STATIC_ROOT_PATH="$public_root"
exec /run.sh "$@"
