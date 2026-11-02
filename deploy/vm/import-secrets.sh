#!/usr/bin/env bash
# Copy the deploy secrets of the running onara 9router into the local secrets
# dir, so deploy.sh can ship them to the dedicated VM. READ-ONLY on onara.
#
#   deploy/vm/import-secrets.sh
#
# Writes (mode 600) into ${DEPLOY_SECRETS_DIR:-~/.config/9router-deploy}:
#   9router.env    /srv/9router/.env verbatim
#   registry.json  docker auth for rg.nl-ams.scw.cloud only (pulls headroom)
#   acme.json      Traefik ACME account + ONLY the $NINEROUTER_HOST certificate,
#                  so TLS is valid the moment DNS flips (no other onara keys)
#   traefik.env    dashboard basic-auth hash from onara; host left empty
#                  (= dashboard router disabled until you set it)
# Existing files are kept unless --force is given.
set -euo pipefail

ONARA_SSH="${ONARA_SSH:-root@2001:bc8:5090:1bc4:dc00:ff:fe42:60ab}"
SECRETS_DIR="${DEPLOY_SECRETS_DIR:-$HOME/.config/9router-deploy}"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

umask 077
mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"

onara() { ssh -o BatchMode=yes -o ConnectTimeout=15 "$ONARA_SSH" "$@"; }

# store NAME CMD...: run CMD, and only if it succeeds with non-empty output
# move the result to $SECRETS_DIR/NAME. Existing files are kept without --force.
store() {
  local name="$1" dest="$SECRETS_DIR/$1" tmp
  shift
  if [ -e "$dest" ] && [ "$FORCE" -ne 1 ]; then
    echo "keep   $dest (exists; --force to overwrite)"
    return 0
  fi
  tmp="$(mktemp "$dest.XXXXXX")"
  if ! "$@" >"$tmp" || [ ! -s "$tmp" ]; then
    rm -f "$tmp"
    echo "ERROR: fetching $name failed" >&2
    return 1
  fi
  mv "$tmp" "$dest"
  echo "wrote  $dest"
}

store 9router.env onara 'cat /srv/9router/.env'

host="$(sed -n 's/^NINEROUTER_HOST=//p' "$SECRETS_DIR/9router.env" | tr -d '"' | tail -n 1)"
host="${host:-router.onara.eu}"

store registry.json onara \
  'jq "{auths: {\"rg.nl-ams.scw.cloud\": .auths[\"rg.nl-ams.scw.cloud\"]}}" /root/.docker/config.json'

store acme.json onara \
  "jq --arg h '$host' '{le: {Account: .le.Account, Certificates: [.le.Certificates[] | select(.domain.main == \$h)]}}' /srv/traefik/acme.json"
if ! jq -e --arg h "$host" '.le.Certificates | map(select(.domain.main == $h)) | length == 1' \
  "$SECRETS_DIR/acme.json" >/dev/null; then
  echo "WARN: acme.json has no certificate for $host; Traefik will request one after DNS points at the VM" >&2
fi

# Compose label on onara escapes `$` as `$$`; .env needs the literal hash,
# single-quoted so compose does not interpolate it.
dashboard_env() {
  local users
  users="$(onara "sed -n 's/.*basicauth.users=\\([^\"]*\\).*/\\1/p' /srv/traefik/docker-compose.yaml")"
  [ -n "$users" ] || return 1
  printf "TRAEFIK_DASHBOARD_HOST=\nTRAEFIK_DASHBOARD_USERS='%s'\n" "$(printf '%s' "$users" | sed 's/\$\$/$/g')"
}
store traefik.env dashboard_env

echo "Secrets ready in $SECRETS_DIR"
