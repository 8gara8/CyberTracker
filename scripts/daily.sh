#!/bin/zsh
export PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
export TZ=Asia/Taipei
ROOT=${0:A:h:h}
cd "$ROOT" || exit 1
mkdir -p logs
[[ $# -eq 0 ]] && set -- --trigger schedule
exec /usr/bin/caffeinate -i "$ROOT/node_modules/.bin/tsx" scripts/daily.ts "$@"
