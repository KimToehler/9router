#!/usr/bin/env bash
# Copy the live 9router state (volume 9router-data: SQLite DB, machine-id,
# auth, mitm, bin, logs) from onara into the VM's 9router-data volume.
#
#   deploy/vm/migrate-data.sh root@<vm-ip>
#
# onara is touched READ-ONLY: the DB is snapshotted with `VACUUM INTO` inside
# the running container (consistent while it keeps serving), the rest is read
# from a read-only mount. Nothing on onara is stopped or modified (the temp
# snapshot inside the container's /tmp is removed afterwards).
#
# On the VM only the 9router container is stopped while its volume is replaced;
# Traefik keeps running. Re-run right before the DNS switch so the VM gets the
# freshest OAuth tokens (see deploy.sh --standby). Settings are copied as-is.
set -euo pipefail

VM_SSH="${1:?usage: migrate-data.sh root@<vm-ip>}"
ONARA_SSH="${ONARA_SSH:-root@2001:bc8:5090:1bc4:dc00:ff:fe42:60ab}"
SNAP=/tmp/9router-migrate.sqlite

onara() { ssh -o BatchMode=yes -o ConnectTimeout=15 "$ONARA_SSH" "$@"; }
vm() { ssh -o BatchMode=yes -o ConnectTimeout=15 "$VM_SSH" "$@"; }

vm 'test -f /srv/9router/docker-compose.yml' || {
  echo "ERROR: $VM_SSH has no /srv/9router deployment yet; run deploy.sh first" >&2
  exit 1
}

echo "== Snapshotting DB on onara (VACUUM INTO, non-blocking for the live app)"
onara "docker exec -i -u node 9router node --no-warnings - && docker exec 9router ls -l $SNAP" <<JS
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
fs.rmSync("$SNAP", { force: true });
const db = new DatabaseSync("/app/data/db/data.sqlite", { readOnly: true });
db.exec("VACUUM INTO '$SNAP'");
db.close();
JS
trap 'onara "docker exec 9router rm -f $SNAP" || true' EXIT

echo "== Stopping 9router on the VM"
vm 'cd /srv/9router && docker compose stop 9router'

echo "== Streaming volume (without live DB files) onara -> VM"
vm 'docker run --rm -v 9router-data:/v alpine sh -c "find /v -mindepth 1 -delete"'
onara "docker run --rm -v 9router-data:/v:ro alpine tar -C /v -czf - \
  --exclude=./db/data.sqlite --exclude=./db/data.sqlite-wal --exclude=./db/data.sqlite-shm ." \
  | vm 'docker run --rm -i -v 9router-data:/v alpine tar -C /v -xzf -'

echo "== Streaming DB snapshot onara -> VM"
onara "docker cp 9router:$SNAP - | gzip -1" \
  | vm 'docker run --rm -i -v 9router-data:/v alpine sh -c "mkdir -p /v/db && gunzip | tar -xO > /v/db/data.sqlite && chown -R 1000:1000 /v && ls -l /v/db/data.sqlite"'

echo "== Integrity check on the VM copy"
vm 'docker run --rm -i -v 9router-data:/v alpine sh' <<'SH'
set -e
apk add -q --no-cache sqlite >/dev/null
result="$(sqlite3 /v/db/data.sqlite 'PRAGMA integrity_check;')"
echo "integrity_check: $result"
[ "$result" = ok ]
echo "tables: $(sqlite3 /v/db/data.sqlite "SELECT count(*) FROM sqlite_master WHERE type='table';")"
SH

echo "== Starting 9router on the VM"
vm 'cd /srv/9router && docker compose up -d 9router'
echo "Data migrated. Run deploy.sh (without --standby) at cutover to enable token refresh."
