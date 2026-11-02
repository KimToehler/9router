#!/usr/bin/env bash
# Create (idempotently) the dedicated 9router VM on OpenStack (Yorizon).
#
#   OS_CLIENT_CONFIG_FILE=docs/clouds.yaml OS_CLOUD=router-test deploy/vm/provision.sh
#
# Creates, unless they already exist (names overridable via env):
#   network/subnet/router  9router-net (10.42.0.0/24) routed to $EXTERNAL_NET
#   security group         9router-sg: ingress tcp 22/80/443 + icmp
#   keypair                9router-deploy from $SSH_PUBKEY
#   server                 9router-prod, $FLAVOR, $IMAGE, ${VOLUME_GB}G boot volume,
#                          cloud-init.yaml as user-data
#   floating IP            new FIP on $EXTERNAL_NET (existing unrelated FIPs untouched)
# Prints the floating IP last.
set -euo pipefail

: "${OS_CLOUD:?set OS_CLOUD (and OS_CLIENT_CONFIG_FILE) for the target project}"
PREFIX="${PREFIX:-9router}"
SERVER="${SERVER:-$PREFIX-prod}"
FLAVOR="${FLAVOR:-SCS-8V-16}"
IMAGE="${IMAGE:-Ubuntu 24.04}"
VOLUME_GB="${VOLUME_GB:-60}"
EXTERNAL_NET="${EXTERNAL_NET:-public}"
SUBNET_CIDR="${SUBNET_CIDR:-10.42.0.0/24}"
DNS_SERVERS="${DNS_SERVERS:-9.9.9.9 1.1.1.1}"
SSH_PUBKEY="${SSH_PUBKEY:-$HOME/.ssh/id_ed25519.pub}"
HERE="$(cd "$(dirname "$0")" && pwd)"

os() { openstack "$@"; }
exists() { os "$1" show "$2" -f value -c id >/dev/null 2>&1; }

if ! exists network "$PREFIX-net"; then
  os network create "$PREFIX-net" -f value -c id
fi
if ! exists subnet "$PREFIX-subnet"; then
  dns_args=()
  for d in $DNS_SERVERS; do dns_args+=(--dns-nameserver "$d"); done
  os subnet create "$PREFIX-subnet" --network "$PREFIX-net" --subnet-range "$SUBNET_CIDR" \
    "${dns_args[@]}" -f value -c id
fi
if ! exists router "$PREFIX-router"; then
  os router create "$PREFIX-router" -f value -c id
  os router set "$PREFIX-router" --external-gateway "$EXTERNAL_NET"
  os router add subnet "$PREFIX-router" "$PREFIX-subnet"
fi

if ! os security group show "$PREFIX-sg" >/dev/null 2>&1; then
  os security group create "$PREFIX-sg" --description "9router: ssh + http(s)" -f value -c id
  for port in 22 80 443; do
    os security group rule create "$PREFIX-sg" --ingress --ethertype IPv4 --protocol tcp --dst-port "$port" -f value -c id
  done
  os security group rule create "$PREFIX-sg" --ingress --ethertype IPv4 --protocol icmp -f value -c id
fi

if ! os keypair show "$PREFIX-deploy" >/dev/null 2>&1; then
  os keypair create "$PREFIX-deploy" --public-key "$SSH_PUBKEY" -f value -c fingerprint
fi

if ! exists server "$SERVER"; then
  os server create "$SERVER" \
    --flavor "$FLAVOR" --image "$IMAGE" --boot-from-volume "$VOLUME_GB" \
    --network "$PREFIX-net" --security-group "$PREFIX-sg" --key-name "$PREFIX-deploy" \
    --user-data "$HERE/cloud-init.yaml" --wait -f value -c id
fi

fips="$(os floating ip list --tags "$SERVER" -f value -c 'Floating IP Address')"
fip="${fips%%$'\n'*}"
if [ -z "$fip" ]; then
  fip="$(os floating ip create "$EXTERNAL_NET" --description "$SERVER public IP" --tag "$SERVER" \
    -f value -c floating_ip_address)"
fi
addresses="$(os server show "$SERVER" -f value -c addresses)"
if [[ "$addresses" != *"$fip"* ]]; then
  os server add floating ip "$SERVER" "$fip"
fi
echo "$fip"
