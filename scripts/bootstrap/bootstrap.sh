#!/bin/sh
set -eu
state=/var/lib/treeseed/bootstrap
manager_state=/var/lib/treeseed/manager
log="$state/bootstrap.log"
install -d -o root -g root -m 0700 "$state"
rm -f "$state/foundation.complete"
rm -f "$manager_state/bootstrap-status.json"
printf '%s generic bootstrap foundation starting\n' "$(date -u +%FT%TZ)" >>"$log"
systemctl stop treeseed-manager-development.timer treeseed-manager-stable.timer treeseed-manager-development.service treeseed-manager-stable.service treeseed-manager-reconcile.service >/dev/null 2>&1 || true
install -d -m 0755 /etc/apt/keyrings /etc/apt/preferences.d
install -m 0644 /usr/share/treeseed/bootstrap/keyrings/treeseed-deployment-stable.gpg /etc/apt/keyrings/treeseed-deployment-stable.gpg
install -m 0644 /usr/share/treeseed/bootstrap/keyrings/treeseed-deployment-development.gpg /etc/apt/keyrings/treeseed-deployment-development.gpg
suite=$(cat /usr/share/treeseed/bootstrap/suite)
case "$suite" in stable|development) ;; *) printf '%s invalid bootstrap suite %s\n' "$(date -u +%FT%TZ)" "$suite" >>"$log"; exit 1 ;; esac
install -m 0644 "/usr/share/treeseed/bootstrap/preferences.$suite" /etc/apt/preferences.d/treeseed-deployment
install -m 0644 /usr/share/treeseed/bootstrap/stable.sources /etc/apt/sources.list.d/treeseed-deployment-stable.sources
install -m 0644 /usr/share/treeseed/bootstrap/development.sources /etc/apt/sources.list.d/treeseed-deployment-development.sources
apt-get -o DPkg::Lock::Timeout=600 update
packages='treeseed-host-runtime treeseed-kata-runtime treeseed-sdk treeseed-cli treeseed-manager'
if [ "$suite" = stable ]; then packages="$packages treeseed-release-catalog"; fi
suite_packages=
for package in $packages; do suite_packages="$suite_packages $package/$suite"; done
if [ "$suite" = development ]; then suite_packages="$suite_packages treeseed-release-catalog-development/development"; fi
apt-get -o DPkg::Lock::Timeout=600 --allow-downgrades --no-remove --no-install-recommends --target-release "$suite" install -y $suite_packages
install -d -o treeseed-manager -g treeseed-manager -m 0750 "$manager_state"
printf '{"complete":false,"foundationReady":false,"initializationRequired":true,"installerCredentialsRetained":false}\n' >"$state/bootstrap-status.json"
install -o root -g treeseed-manager -m 0640 "$state/bootstrap-status.json" "$manager_state/bootstrap-status.json"
rm -f "$state/bootstrap-status.json"
/usr/lib/treeseed/manager/bin/initialize-pki
systemctl enable treeseed-manager-supervisor.service treeseed-manager-api.service
systemctl restart treeseed-manager-supervisor.service treeseed-manager-api.service
/usr/lib/treeseed/runtime/bin/node /usr/lib/treeseed/manager/dist/src/bin/wait-supervisor.js
touch "$state/foundation.complete"
chmod 0600 "$state/foundation.complete"
printf '{"complete":false,"foundationReady":true,"initializationRequired":true,"installerCredentialsRetained":false}\n' >"$state/bootstrap-status.json"
install -o root -g treeseed-manager -m 0640 "$state/bootstrap-status.json" "$manager_state/bootstrap-status.json"
rm -f "$state/bootstrap-status.json"
systemctl disable treeseed-bootstrap.service >/dev/null 2>&1 || true
printf '%s manager foundation ready; explicit profile initialization is required before activation\n' "$(date -u +%FT%TZ)" >>"$log"
