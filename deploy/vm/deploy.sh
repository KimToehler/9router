#!/usr/bin/env bash
# Deploy the 9router fork (+ optional headroom) + Traefik to the dedicated VM.
#
#   deploy/vm/deploy.sh [--standby] [--ref <git-ref>] root@<vm-ip>
#
# Ships to the VM:
#   /srv/9router/src                  `git archive <ref>` of this repo (default HEAD)
#   /srv/9router/docker-compose.yml   deploy/vm/9router/docker-compose.yml
#   /srv/9router/.env                 $SECRETS/9router.env + deploy-managed keys
#   /srv/traefik/*                    deploy/vm/traefik/* + $SECRETS/traefik.env
#   /srv/traefik/acme.json            $SECRETS/acme.json, ONLY if the VM has none
#                                     (never clobbers certificates renewed there)
#   /root/.docker/config.json         $SECRETS/registry.json (headroom image pull)
# then builds 9router:fork-<sha> natively on the VM, pulls pause/traefik (and
# headroom if COMPOSE_PROFILES=headroom is in 9router.env),
# `docker compose up -d`, waits for the healthcheck and probes
# https://$NINEROUTER_HOST/api/health through Traefik on the VM's IP.
#
# --standby  sets DISABLE_BACKGROUND_TOKEN_REFRESH=true. Use it while onara
#            still serves traffic: both instances hold the same OAuth refresh
#            tokens, and a refresh on the VM would rotate them and log onara's
#            accounts out. Deploy WITHOUT it at cutover (after migrate-data.sh).
#
# Secrets dir: ${DEPLOY_SECRETS_DIR:-~/.config/9router-deploy} (import-secrets.sh).
set -euo pipefail

STANDBY=0
REF=HEAD
VM_SSH=""
while [ $# -gt 0 ]; do
  case "$1" in
    --standby) STANDBY=1 ;;
    --ref) REF="${2:?--ref needs a value}"; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) VM_SSH="$1" ;;
  esac
  shift
done
[ -n "$VM_SSH" ] || { echo "usage: deploy.sh [--standby] [--ref <git-ref>] root@<vm-ip>" >&2; exit 2; }

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(git -C "$HERE" rev-parse --show-toplevel)"
SECRETS="${DEPLOY_SECRETS_DIR:-$HOME/.config/9router-deploy}"
VM_HOST="${VM_SSH#*@}"

for f in 9router.env registry.json acme.json traefik.env; do
  [ -s "$SECRETS/$f" ] || { echo "ERROR: missing $SECRETS/$f (run deploy/vm/import-secrets.sh)" >&2; exit 1; }
done

SHA="$(git -C "$REPO" rev-parse --short=12 "$REF^{commit}")"
VERSION="$(git -C "$REPO" show "$SHA:package.json" | sed -n 's/^  "version": "\(.*\)",$/\1/p')"
IMAGE="9router:fork-$SHA"
if [ "$REF" = HEAD ] && [ -n "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]; then
  echo "WARN: uncommitted changes are NOT deployed; shipping commit $SHA" >&2
fi
NINEROUTER_HOST="$(sed -n 's/^NINEROUTER_HOST=//p' "$SECRETS/9router.env" | tr -d '"' | tail -n 1)"
NINEROUTER_HOST="${NINEROUTER_HOST:-router.onara.eu}"
DASHBOARD_HOST="$(sed -n 's/^TRAEFIK_DASHBOARD_HOST=//p' "$SECRETS/traefik.env" | tr -d "\"'" | tail -n 1)"

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=30)
vm() { ssh "${SSH_OPTS[@]}" "$VM_SSH" "$@"; }
# put LOCAL REMOTE MODE: upload one file atomically.
put() { vm "umask 077; cat > '$2.tmp' && chmod $3 '$2.tmp' && mv '$2.tmp' '$2'" <"$1"; }

echo "== Deploying $IMAGE (v$VERSION) to $VM_SSH (standby=$STANDBY)"
vm 'cloud-init status --wait >/dev/null 2>&1 || true; command -v docker >/dev/null && docker compose version >/dev/null' || {
  echo "ERROR: docker/compose not available on $VM_SSH (cloud-init still running or failed?)" >&2
  exit 1
}
vm 'mkdir -p /srv/9router /srv/traefik /root/.docker'

echo "== Shipping source"
git -C "$REPO" archive --format=tar.gz "$SHA" \
  | vm 'rm -rf /srv/9router/src.new && mkdir -p /srv/9router/src.new && tar -xzf - -C /srv/9router/src.new && rm -rf /srv/9router/src && mv /srv/9router/src.new /srv/9router/src'

echo "== Shipping config"
put "$HERE/9router/docker-compose.yml" /srv/9router/docker-compose.yml 644
ENV_TMP="$(mktemp)"
trap 'rm -f "$ENV_TMP"' EXIT
{
  grep -v -E '^(NINEROUTER_IMAGE|APP_VERSION|DISABLE_BACKGROUND_TOKEN_REFRESH)=' "$SECRETS/9router.env"
  echo
  echo "# --- managed by deploy/vm/deploy.sh ---"
  echo "NINEROUTER_IMAGE=$IMAGE"
  echo "APP_VERSION=$VERSION"
  [ "$STANDBY" -eq 1 ] && echo "DISABLE_BACKGROUND_TOKEN_REFRESH=true"
  true
} >"$ENV_TMP"
put "$ENV_TMP" /srv/9router/.env 600
put "$HERE/traefik/docker-compose.yaml" /srv/traefik/docker-compose.yaml 644
put "$HERE/traefik/docker-compose.dashboard.yaml" /srv/traefik/docker-compose.dashboard.yaml 644
put "$HERE/traefik/traefik.yml" /srv/traefik/traefik.yml 644
put "$SECRETS/traefik.env" /srv/traefik/.env 600
put "$SECRETS/registry.json" /root/.docker/config.json 600
if vm 'test -s /srv/traefik/acme.json'; then
  echo "keep   /srv/traefik/acme.json (already on VM)"
else
  put "$SECRETS/acme.json" /srv/traefik/acme.json 600
fi

echo "== Starting Traefik"
TRAEFIK_FILES="-f docker-compose.yaml"
[ -n "$DASHBOARD_HOST" ] && TRAEFIK_FILES="$TRAEFIK_FILES -f docker-compose.dashboard.yaml"
vm "docker network inspect traefik >/dev/null 2>&1 || docker network create traefik >/dev/null
cd /srv/traefik && docker compose $TRAEFIK_FILES pull -q && docker compose $TRAEFIK_FILES up -d --remove-orphans"

echo "== Building $IMAGE on the VM"
vm 'cd /srv/9router && docker compose pull -q --ignore-buildable && docker compose build 9router'

echo "== Rolling out"
# headroom is profile-gated; `up` neither starts nor removes a disabled profile's
# container, so remove it explicitly when the profile is off.
# Compose recreates `netns` on config change but NOT the services joined to it
# (network_mode: service:netns); they would keep the dead namespace and Traefik
# answers 502. Recreate any member whose namespace is not the current netns.
vm 'cd /srv/9router && active="$(docker compose config --services)"
case " $(echo $active) " in *" headroom "*) ;; *) docker compose rm -sf headroom ;; esac
docker compose up -d --remove-orphans
ns="container:$(docker inspect -f "{{.Id}}" 9router-netns)"
stale=""
for c in $active; do
  [ "$c" = netns ] && continue
  [ "$(docker inspect -f "{{.HostConfig.NetworkMode}}" "$c")" = "$ns" ] || stale="$stale $c"
done
if [ -n "$stale" ]; then
  echo "netns changed; recreating:$stale"
  docker compose up -d --force-recreate --no-deps $stale
fi'

echo "== Waiting for 9router healthcheck"
vm 'for i in $(seq 1 60); do
  s="$(docker inspect -f "{{.State.Health.Status}}" 9router 2>/dev/null || echo missing)"
  [ "$s" = healthy ] && { echo "9router healthy"; exit 0; }
  sleep 5
done
echo "9router not healthy (last: $s)"; docker logs --tail 50 9router; exit 1'
vm 'docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}"; docker image prune -f >/dev/null'

echo "== Probing https://$NINEROUTER_HOST/api/health via $VM_HOST"
RESOLVE_IP="$VM_HOST"
case "$RESOLVE_IP" in *:*) RESOLVE_IP="[$RESOLVE_IP]" ;; esac
code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 \
  --resolve "$NINEROUTER_HOST:443:$RESOLVE_IP" "https://$NINEROUTER_HOST/api/health" || true)"
echo "HTTPS /api/health -> $code"
[ "$code" = 200 ] || { echo "ERROR: Traefik/TLS probe failed" >&2; exit 1; }
echo "Deployed $IMAGE."
