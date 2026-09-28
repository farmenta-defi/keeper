#!/usr/bin/env sh
set -eu
# cron starts in $HOME with PATH=/usr/bin:/bin. Bun reads .env from the working directory, and
# its installer puts the binary in ~/.bun/bin.
cd "$(dirname "$0")/.."
PATH="$HOME/.bun/bin:$PATH"
export PATH
exec flock -n /tmp/farmenta-keeper-record-batch.lock bun run keeper:primary
