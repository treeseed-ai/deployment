#!/bin/sh
set -eu
if ! /usr/bin/docker network inspect treeseed-edge >/dev/null 2>&1; then
  /usr/bin/docker network create --driver bridge treeseed-edge >/dev/null
fi
