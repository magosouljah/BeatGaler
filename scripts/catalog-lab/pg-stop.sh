#!/bin/bash
# Detiene y borra el clúster EFÍMERO del LAB navegador. Uso: pg-stop.sh [DIRECTORIO]  (solo /tmp/bg-catlab-*).
# Idempotente. Solo borra el directorio cuando el servidor está comprobadamente detenido; si no se puede detener, NO borra (exit 4).
D="${1:-/tmp/bg-catlab-browser}"
BIN=/usr/lib/postgresql/18/bin
case "$D" in /tmp/bg-catlab-*) ;; *) echo "directorio fuera de /tmp/bg-catlab-*: $D"; exit 2;; esac
case "$D" in *..*|*' '*|*"'"*) echo "directorio no permitido: $D"; exit 2;; esac
pg_running() { [ -f "$D/data/postmaster.pid" ] && su postgres -c "$BIN/pg_ctl -D $D/data status" >/dev/null 2>&1; }
if pg_running; then
  su postgres -c "$BIN/pg_ctl -D $D/data stop -m fast -w -t 60" >/dev/null 2>&1 || true
  if pg_running; then echo "el servidor de $D sigue en marcha: NO se borra el directorio"; exit 4; fi
fi
rm -rf "$D"
echo "lab PG detenido y borrado ($D)"
