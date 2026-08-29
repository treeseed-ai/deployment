#!/bin/sh
if [ -z "${TREESEED_API_BASE_URL:-}" ] && [ -r /etc/treeseed/cli/api-base-url ]; then
	TREESEED_API_BASE_URL=$(cat /etc/treeseed/cli/api-base-url)
	export TREESEED_API_BASE_URL
fi
if [ -z "${NODE_EXTRA_CA_CERTS:-}" ] && [ -r /etc/treeseed/cli/localhost-ca.crt ]; then
	NODE_EXTRA_CA_CERTS=/etc/treeseed/cli/localhost-ca.crt
	export NODE_EXTRA_CA_CERTS
fi

if [ -n "${XDG_STATE_HOME:-}" ]; then
	TREESEED_CLI_SELECTION="${XDG_STATE_HOME}/treeseed/development/cli-entrypoint"
elif [ -n "${HOME:-}" ]; then
	TREESEED_CLI_SELECTION="${HOME}/.local/state/treeseed/development/cli-entrypoint"
else
	TREESEED_CLI_SELECTION=
fi

if [ -n "$TREESEED_CLI_SELECTION" ] && [ -r "$TREESEED_CLI_SELECTION" ]; then
	{
		IFS= read -r TREESEED_CLI_SELECTION_VERSION
		IFS= read -r TREESEED_CLI_SELECTION_EXPIRES
		IFS= read -r TREESEED_DEVELOPMENT_CLI
	} < "$TREESEED_CLI_SELECTION"
	if [ "$TREESEED_CLI_SELECTION_VERSION" = treeseed.development-cli-selection/v1 ]; then
		case "$TREESEED_CLI_SELECTION_EXPIRES" in
			''|*[!0-9]*) ;;
			*)
				if [ "$(date +%s)" -lt "$TREESEED_CLI_SELECTION_EXPIRES" ]; then
					case "$TREESEED_DEVELOPMENT_CLI" in
						/*)
							if [ -f "$TREESEED_DEVELOPMENT_CLI" ] && [ -r "$TREESEED_DEVELOPMENT_CLI" ]; then
								exec /usr/lib/treeseed/runtime/bin/node "$TREESEED_DEVELOPMENT_CLI" "$@"
							fi
							;;
					esac
				fi
				;;
		esac
	fi
fi

exec /usr/lib/treeseed/runtime/bin/node /usr/lib/treeseed/cli/dist/cli/main.js "$@"
