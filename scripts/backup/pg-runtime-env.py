#!/usr/bin/env python3
"""Run pg-backup/restore with the live Cloud PostgreSQL identity, without leaking
DATABASE_URL into arguments, logs, crontab, or persistent credential files.
Executes as root to read /proc/<cloud PID>/environ. Secrets remain in child env.
"""
import os
import pathlib
import subprocess
import sys
from urllib.parse import urlsplit, unquote, parse_qs

MODE = "restore" if len(sys.argv) > 1 and sys.argv[1] == "--restore" else "backup"
args = sys.argv[2:] if MODE == "restore" else []
pid = subprocess.check_output(
    ["systemctl", "show", "-p", "MainPID", "--value", "beatgaler-cloud.service"],
    text=True, timeout=10
).strip()
if not pid.isdigit() or pid == "0":
    raise SystemExit("STOP: BeatGaler Cloud not running; PostgreSQL credentials unavailable")

raw = pathlib.Path("/proc") / pid / "environ"
pairs = (part.split(b"=", 1) for part in raw.read_bytes().split(b"\0") if b"=" in part)
remote = dict(pairs)
uri = remote.get(b"DATABASE_URL", b"").decode()
if not uri:
    raise SystemExit("STOP: Cloud has no DATABASE_URL")
parsed = urlsplit(uri)
if parsed.scheme not in ("postgres", "postgresql") or not parsed.hostname or not parsed.path:
    raise SystemExit("STOP: Cloud DATABASE_URL has unsupported format")

env = os.environ.copy()
env.update({
    "PGHOST": parsed.hostname,
    "PGPORT": str(parsed.port or 5432),
    "PGUSER": unquote(parsed.username or ""),
    "PGPASSWORD": unquote(parsed.password or ""),
    "PGDATABASE": unquote(parsed.path[1:]),
    "BACKUP_DB": unquote(parsed.path[1:]),
})
if not env["PGUSER"] or not env["PGDATABASE"]:
    raise SystemExit("STOP: incomplete PostgreSQL identity")
cert = remote.get(b"NODE_EXTRA_CA_CERTS", b"").decode()
if cert and pathlib.Path(cert).is_file():
    env["PGSSLROOTCERT"] = cert
    env["PGSSLMODE"] = "verify-full"
else:
    env["PGSSLMODE"] = parse_qs(parsed.query).get("sslmode", ["require"])[0]
if MODE == "restore":
    if len(args) != 2:
        raise SystemExit("usage: pg-runtime-env.py --restore bk-id database_restore_name")
    env["BACKUP_SOURCE"] = env.get("BACKUP_TARGET", "")
    command = ["/usr/bin/bash", "/opt/beatgaler/backup/pg-restore-s3-kms.sh", *args]
else:
    command = ["/usr/bin/bash", "/opt/beatgaler/backup/pg-backup-s3-kms.sh"]
os.execvpe(command[0], command, env)
