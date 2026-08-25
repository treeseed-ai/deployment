#!/bin/sh
if [ -z "${TREESEED_API_BASE_URL:-}" ] && [ -r /etc/treeseed/cli/api-base-url ]; then
	TREESEED_API_BASE_URL=$(cat /etc/treeseed/cli/api-base-url)
	export TREESEED_API_BASE_URL
fi
if [ -z "${NODE_EXTRA_CA_CERTS:-}" ] && [ -r /etc/treeseed/cli/localhost-ca.crt ]; then
	NODE_EXTRA_CA_CERTS=/etc/treeseed/cli/localhost-ca.crt
	export NODE_EXTRA_CA_CERTS
fi
exec /usr/lib/treeseed/runtime/bin/node /usr/lib/treeseed/cli/dist/cli/main.js "$@"
