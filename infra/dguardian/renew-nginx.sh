#!/bin/sh
set -eu
nginx -t -q
systemctl reload nginx
