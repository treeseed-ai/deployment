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
deployment_version=$(dpkg-query -W -f='${Version}' treeseed)
release_packages='treeseed-host-runtime treeseed-kata-runtime treeseed-manager'
if [ "$suite" = development ]; then release_packages="$release_packages treeseed-release-catalog-development"; fi
for package in $release_packages; do
	candidate=$(apt-cache policy "$package" | sed -n 's/^[[:space:]]*Candidate:[[:space:]]*//p' | head -n 1)
	if [ "$candidate" != "$deployment_version" ]; then
		printf '%s bootstrap release %s is not yet visible for %s (candidate %s); retrying after repository convergence\n' "$(date -u +%FT%TZ)" "$deployment_version" "$package" "${candidate:-none}" >>"$log"
		exit 75
	fi
done
suite_packages="treeseed-host-runtime=$deployment_version treeseed-kata-runtime=$deployment_version treeseed-manager=$deployment_version"
if [ "$suite" = stable ]; then suite_packages="$suite_packages treeseed-release-catalog/stable"; fi
if [ "$suite" = development ]; then suite_packages="$suite_packages treeseed-release-catalog-development=$deployment_version"; fi
apt-get -o DPkg::Lock::Timeout=600 --allow-downgrades --no-remove --no-install-recommends --target-release "$suite" install -y $suite_packages
systemctl disable --now treeseed-manager-development.timer treeseed-manager-stable.timer >/dev/null 2>&1 || true
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
