#!/bin/bash
# Detiene y borra el clúster EFÍMERO del LAB navegador. Uso: pg-stop.sh [DIRECTORIO]  (solo /tmp/bg-catlab-*).
D="${1:-/tmp/bg-catlab-browser}"
BIN=/usr/lib/postgresql/18/bin
case "$D" in /tmp/bg-catlab-*) ;; *) echo "directorio fuera de /tmp/bg-catlab-*: $D"; exit 2;; esac
[ -d "$D/data" ] && su postgres -c "$BIN/pg_ctl -D $D/data stop -m fast" || true
rm -rf "$D"
echo "lab PG detenido y borrado ($D)"
