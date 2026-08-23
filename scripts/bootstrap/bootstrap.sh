#!/bin/sh
set -eu
state=/var/lib/treeseed/bootstrap
seed="$state/seed/platform.json"
log="$state/bootstrap.log"
install -d -o root -g root -m 0700 "$state" "$state/seed"
printf '%s bootstrap starting\n' "$(date -u +%FT%TZ)" >>"$log"
install -d -m 0755 /etc/apt/keyrings /etc/apt/preferences.d
install -m 0644 /usr/share/treeseed/bootstrap/keyrings/treeseed-deployment-stable.gpg /etc/apt/keyrings/treeseed-deployment-stable.gpg
install -m 0644 /usr/share/treeseed/bootstrap/keyrings/treeseed-deployment-development.gpg /etc/apt/keyrings/treeseed-deployment-development.gpg
install -m 0644 /usr/share/treeseed/bootstrap/stable.sources /etc/apt/sources.list.d/treeseed-deployment-stable.sources
install -m 0644 /usr/share/treeseed/bootstrap/preferences /etc/apt/preferences.d/treeseed-deployment
if [ "$(cat /usr/share/treeseed/bootstrap/suite)" = development ]; then
  install -m 0644 /usr/share/treeseed/bootstrap/development.sources /etc/apt/sources.list.d/treeseed-deployment-development.sources
fi
apt-get -o DPkg::Lock::Timeout=600 update
packages='treeseed-host-runtime treeseed-sdk treeseed-cli treeseed-release-catalog treeseed-manager treeseed-edge'
for component in $(jq -r '.components | to_entries[] | select(.value.enabled == true) | .key' "$seed"); do
  case "$component" in api|agent|treedx|ai) packages="$packages treeseed-component-$component";; lab) packages="$packages treeseed-lab";; esac
done
apt-get -o DPkg::Lock::Timeout=600 --no-remove --no-install-recommends install -y $packages
install -o root -g treeseed-manager -m 0640 "$seed" /etc/treeseed/platform.json
if [ -f "$state/seed/credentials.json" ]; then
  install -d -o root -g root -m 0700 /etc/treeseed/credentials
  install -o root -g root -m 0600 "$state/seed/credentials.json" /etc/treeseed/credentials/bootstrap.json
  rm -f "$state/seed/credentials.json"
fi
/usr/lib/treeseed/manager/bin/initialize-pki
systemctl enable --now treeseed-manager-supervisor.service treeseed-manager-api.service treeseed-manager-stable.timer treeseed-manager-development.timer
systemctl start treeseed-manager-reconcile.service || printf '%s initial reconciliation degraded; inspect manager receipts\n' "$(date -u +%FT%TZ)" >>"$log"
touch "$state/handoff.complete"
chmod 0600 "$state/handoff.complete"
systemctl disable treeseed-bootstrap.service >/dev/null 2>&1 || true
printf '%s manager handoff complete; securely delete the downloaded configured .deb because it may contain bootstrap credentials\n' "$(date -u +%FT%TZ)" >>"$log"
