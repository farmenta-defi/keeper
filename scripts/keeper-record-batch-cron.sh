#!/usr/bin/env sh
set -eu
exec flock -n /tmp/farmenta-keeper-record-batch.lock bun run keeper:primary
