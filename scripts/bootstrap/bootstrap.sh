#!/bin/sh
set -eu
state=/var/lib/treeseed/bootstrap
seed="$state/seed/platform.json"
log="$state/bootstrap.log"
install -d -o root -g root -m 0700 "$state" "$state/seed"
printf '%s bootstrap starting\n' "$(date -u +%FT%TZ)" >>"$log"
systemctl stop treeseed-manager-development.timer treeseed-manager-stable.timer treeseed-manager-development.service treeseed-manager-stable.service treeseed-manager-reconcile.service >/dev/null 2>&1 || true
install -d -m 0755 /etc/apt/keyrings /etc/apt/preferences.d
install -m 0644 /usr/share/treeseed/bootstrap/keyrings/treeseed-deployment-stable.gpg /etc/apt/keyrings/treeseed-deployment-stable.gpg
install -m 0644 /usr/share/treeseed/bootstrap/keyrings/treeseed-deployment-development.gpg /etc/apt/keyrings/treeseed-deployment-development.gpg
install -m 0644 /usr/share/treeseed/bootstrap/preferences /etc/apt/preferences.d/treeseed-deployment
suite=$(cat /usr/share/treeseed/bootstrap/suite)
if [ "$suite" = development ]; then
  install -m 0644 /usr/share/treeseed/bootstrap/development.sources /etc/apt/sources.list.d/treeseed-deployment-development.sources
  rm -f /etc/apt/sources.list.d/treeseed-deployment-stable.sources
else
  install -m 0644 /usr/share/treeseed/bootstrap/stable.sources /etc/apt/sources.list.d/treeseed-deployment-stable.sources
  rm -f /etc/apt/sources.list.d/treeseed-deployment-development.sources
fi
apt-get -o DPkg::Lock::Timeout=600 update
packages='treeseed-host-runtime treeseed-sdk treeseed-cli treeseed-release-catalog treeseed-manager treeseed-edge'
apt-get -o DPkg::Lock::Timeout=600 --no-remove --no-install-recommends install -y $packages
install -o root -g treeseed-manager -m 0640 "$seed" /etc/treeseed/platform.json
rm -f "$seed"
if [ -f "$state/seed/credentials.json" ]; then
  install -d -o root -g root -m 0700 /etc/treeseed/credentials
  jq -e 'type == "object" and all(keys[]; test("^[a-z][a-z0-9.-]{1,63}$")) and all(.[]; type == "string" and length > 0 and length <= 65536)' "$state/seed/credentials.json" >/dev/null
  for secret_id in $(jq -r 'keys[]' "$state/seed/credentials.json"); do
    temporary="/etc/treeseed/credentials/.${secret_id}.new"
    jq -jr --arg id "$secret_id" '.[$id]' "$state/seed/credentials.json" >"$temporary"
    chmod 0600 "$temporary"
    mv -f "$temporary" "/etc/treeseed/credentials/$secret_id"
  done
  rm -f "$state/seed/credentials.json"
fi
rm -f "$state/seed/operator"
/usr/lib/treeseed/manager/bin/initialize-pki
systemctl enable treeseed-manager-supervisor.service treeseed-manager-api.service treeseed-manager-stable.timer treeseed-manager-development.timer
systemctl restart treeseed-manager-supervisor.service treeseed-manager-api.service
attempt=0
while [ ! -S /run/treeseed/manager/supervisor.sock ]; do
  attempt=$((attempt + 1))
  [ "$attempt" -le 30 ] || { printf '%s supervisor socket did not become ready\n' "$(date -u +%FT%TZ)" >>"$log"; exit 1; }
  sleep 1
done
if [ -f "$state/seed/reset-unaccepted-components.json" ]; then
  /usr/lib/treeseed/runtime/bin/node /usr/lib/treeseed/manager/dist/src/bin/bootstrap-reset.js
fi
systemctl start treeseed-manager-reconcile.service || printf '%s initial reconciliation degraded; inspect manager receipts\n' "$(date -u +%FT%TZ)" >>"$log"
systemctl start treeseed-manager-stable.timer treeseed-manager-development.timer
touch "$state/handoff.complete"
chmod 0600 "$state/handoff.complete"
systemctl disable treeseed-bootstrap.service >/dev/null 2>&1 || true
printf '%s manager handoff complete; securely delete the downloaded configured .deb because it may contain bootstrap credentials\n' "$(date -u +%FT%TZ)" >>"$log"
