#!/bin/sh
set -eu
tls=/etc/treeseed/manager/tls
edge=/etc/treeseed/edge/tls
install -d -o root -g treeseed-manager -m 0750 "$tls"
install -d -o root -g root -m 0750 "$edge"
if [ ! -f "$tls/ca.key" ]; then
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$tls/ca.key"
  openssl req -x509 -new -key "$tls/ca.key" -sha256 -days 3650 -subj '/CN=TreeSeed Local Host CA' -out "$tls/ca.crt"
fi
aliases=$(jq -r '.network.manager.aliases[]' /etc/treeseed/platform.json)
san='DNS:localhost,IP:127.0.0.1'
for alias in $aliases; do san="$san,DNS:$alias"; done
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$tls/server.key"
openssl req -new -key "$tls/server.key" -subj '/CN=manager.treeseed.localhost' -out "$tls/server.csr"
printf 'subjectAltName=%s\nextendedKeyUsage=serverAuth\n' "$san" >"$tls/server.ext"
openssl x509 -req -in "$tls/server.csr" -CA "$tls/ca.crt" -CAkey "$tls/ca.key" -CAcreateserial -days 825 -sha256 -extfile "$tls/server.ext" -out "$tls/server.crt"
rm -f "$tls/server.csr" "$tls/server.ext"
cp "$tls/ca.crt" "$edge/client-ca.crt"
cp "$tls/server.crt" "$edge/host.crt"
cp "$tls/server.key" "$edge/host.key"
chown root:treeseed-manager "$tls/ca.crt" "$tls/server.crt" "$tls/server.key"
chmod 0640 "$tls/ca.crt" "$tls/server.crt" "$tls/server.key"
chown root:root "$tls/ca.key" "$tls/ca.srl"
chmod 0600 "$tls/ca.key" "$tls/ca.srl"
chmod 0640 "$edge"/*
