'use strict';
// G4: la plantilla S3 y los scripts de backup/restore cumplen las propiedades de seguridad exigidas (sin tocar AWS ni PostgreSQL).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const root = path.join(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const cfn = JSON.parse(read('deploy/backup/backup-bucket.cfn.json'));

test('bucket: versionado, Object Lock GOVERNANCE, SSE-KMS con rotación, sin acceso público, solo TLS, lifecycle de retención', () => {
  const b = cfn.Resources.BackupBucket.Properties;
  assert.equal(b.VersioningConfiguration.Status, 'Enabled'); assert.equal(b.ObjectLockConfiguration.Rule.DefaultRetention.Mode, 'GOVERNANCE');
  assert.equal(b.BucketEncryption.ServerSideEncryptionConfiguration[0].ServerSideEncryptionByDefault.SSEAlgorithm, 'aws:kms');
  assert.equal(cfn.Resources.BackupKey.Properties.EnableKeyRotation, true);
  assert.deepEqual(Object.values(b.PublicAccessBlockConfiguration), [true, true, true, true]);
  assert.equal(cfn.Resources.BackupBucket.DeletionPolicy, 'Retain');
  const rule = b.LifecycleConfiguration.Rules[0]; assert.ok(rule.ExpirationInDays && rule.NoncurrentVersionExpiration && rule.AbortIncompleteMultipartUpload);
  const pol = JSON.stringify(cfn.Resources.BackupBucketPolicy.Properties.PolicyDocument);
  assert.match(pol, /aws:SecureTransport/); assert.match(pol, /s3:x-amz-server-side-encryption/); assert.match(pol, /s3:DeleteObjectVersion/);
});

test('IAM: el escritor solo escribe (sin Get/List/Delete) y el lector solo lee', () => {
  const actions = (n) => cfn.Resources[n].Properties.PolicyDocument.Statement.flatMap((s) => s.Action);
  const w = actions('BackupWriterPolicy'); const r = actions('BackupReaderPolicy');
  assert.ok(w.includes('s3:PutObject')); assert.ok(!w.some((a) => /Get|List|Delete|\*/.test(a.replace('kms:GenerateDataKey', ''))));
  assert.ok(r.includes('s3:GetObject') && r.includes('s3:ListBucket')); assert.ok(!r.some((a) => /Put|Delete|\*/.test(a)));
});

test('scripts: sintaxis bash válida y el README declara que S3 no respalda los audios', () => {
  for (const f of ['pg-backup.sh', 'pg-restore.sh', 'pg-drill.sh']) execFileSync('bash', ['-n', path.join(root, 'scripts/backup', f)]);
  assert.match(read('deploy/backup/README.md'), /S3 \*\*no\*\* respalda los audios/);
});

// Herramientas simuladas (funciones bash) que registran sus argumentos: ejecutan el script real sin PostgreSQL, openssl ni AWS.
const FAKE_TOOLS = String.raw`
export PATH=/usr/bin:/bin
log() { printf '%s\n' "$*" >> "$FAKE_LOG"; }
stat() { if [ "$1" = -c ] && [ "$2" = %a ]; then echo "$FAKE_MODE"; else command stat "$@"; fi; }
argval() { local want="$1"; shift; while [ $# -gt 0 ]; do [ "$1" = "$want" ] && { echo "$2"; return; }; shift; done; }
psql() {
  log "psql $*"
  case " $* " in
    *" -c "*) case "$*" in *to_regclass*) echo "$FAKE_HAS_NATIVE" ;; *"FROM pg_database"*) echo "$FAKE_DB_EXISTS" ;; *schema_migrations*) echo "$FAKE_LAST" ;; *"FROM users"*) echo 1 ;; *"FROM vaults"*) echo 2 ;; *library_beats*) echo 3 ;; esac ;;
    *" -o "*) cat >> "$FAKE_LOG.stdin"; printf '{"fake":"manifest"}' > "$(argval -o "$@")" ;;
    *) local l; while IFS= read -r l; do case "$l" in SELECT*) echo 00000003-1 ;; '\q') exit 0 ;; esac; done ;;
  esac
}
pg_dump() { log "pg_dump $*"; printf 'FAKE-DUMP' > "$(argval -f "$@")"; }
pg_restore() { log "pg_restore $*"; case " $* " in *" --list "*) return 0 ;; esac; return "$FAKE_PGRESTORE_RC"; }
openssl() { log "openssl $*"; cp "$(argval -in "$@")" "$(argval -out "$@")"; }
aws() { log "aws $*"; }
createdb() { log "createdb $*"; }
dropdb() { log "dropdb $*"; }
node() { log "node $*"; }
`;

function runScript(t, name, args, { env = {}, files = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-script-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'pass'), 'S3CRET-PASSPHRASE');
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), text);
  const script = path.join(root, 'scripts/backup', name).split(path.sep).join('/');
  const result = spawnSync('bash', ['--noprofile', '--norc', '-c', `${FAKE_TOOLS}\nsource "$@"`, 'x', script, ...args], {
    cwd: dir, encoding: 'utf8', timeout: 30_000,
    env: { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, FAKE_LOG: './calls.log', FAKE_MODE: '600', FAKE_HAS_NATIVE: 'f', FAKE_DB_EXISTS: '', FAKE_LAST: 'V9', FAKE_PGRESTORE_RC: '0', BACKUP_PASSPHRASE_FILE: './pass', ...env },
  });
  assert.ifError(result.error);
  const calls = fs.existsSync(path.join(dir, 'calls.log')) ? fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').split('\n').filter(Boolean) : [];
  const stdinSql = fs.existsSync(path.join(dir, 'calls.log.stdin')) ? fs.readFileSync(path.join(dir, 'calls.log.stdin'), 'utf8') : '';
  return { dir, result, calls, stdinSql };
}
const sha = (b) => createHash('sha256').update(b).digest('hex');

test('backup a file://: snapshot MVCC compartido, cifrado AES-256/PBKDF2, manifiesto verificable, sin secretos en argumentos ni salida', (t) => {
  const { dir, result, calls, stdinSql } = runScript(t, 'pg-backup.sh', [], {
    env: { BACKUP_DB: 'beatgaler', BACKUP_TARGET: 'file://out', BACKUP_ID: 'bk-t1' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /backup OK id=bk-t1 .*mode=pre-native/);
  const dump = calls.find((c) => c.startsWith('pg_dump '));
  assert.match(dump, /--snapshot=00000003-1 -Fc .*--no-owner --no-acl -d beatgaler -f /);
  const ssl = calls.find((c) => c.startsWith('openssl '));
  assert.match(ssl, /^openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -pass file:\.\/pass -in \S+ -out \S+$/);
  assert.match(stdinSql, /POSTGRES_ONLY: Telegram media bytes are NOT in this backup/);
  assert.match(stdinSql, /SET TRANSACTION SNAPSHOT/);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'out')).sort(), ['bk-t1.dump.enc', 'bk-t1.manifest.json', 'bk-t1.manifest.json.sha256']);
  assert.equal(fs.readFileSync(path.join(dir, 'out/bk-t1.dump.enc'), 'utf8'), 'FAKE-DUMP');
  const manifest = fs.readFileSync(path.join(dir, 'out/bk-t1.manifest.json'));
  assert.equal(fs.readFileSync(path.join(dir, 'out/bk-t1.manifest.json.sha256'), 'utf8'), `${sha(manifest)}  bk-t1.manifest.json\n`);
  for (const secret of ['S3CRET-PASSPHRASE']) {
    assert.ok(!calls.join('\n').includes(secret) && !result.stdout.includes(secret) && !result.stderr.includes(secret));
  }
  assert.ok(!calls.some((c) => c.startsWith('aws ')));
});

test('backup a s3://: sube con SSE-KMS, el cifrado antes que el manifiesto, y detecta el catálogo nativo', (t) => {
  const { result, calls, stdinSql } = runScript(t, 'pg-backup.sh', [], {
    env: { BACKUP_DB: 'beatgaler', BACKUP_TARGET: 's3://bucket/pfx/', BACKUP_ID: 'bk-t2', FAKE_HAS_NATIVE: 't', S3_SSE_KMS_KEY_ID: 'key-1' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /mode=native/);
  assert.match(stdinSql, /catalog_beats/);
  const puts = calls.filter((c) => c.startsWith('aws '));
  assert.equal(puts.length, 3);
  assert.ok(puts.every((c) => /^aws s3 cp --only-show-errors --sse aws:kms --sse-kms-key-id key-1 /.test(c)));
  assert.deepEqual(puts.map((c) => c.split(' ').pop()), ['s3://bucket/pfx/bk-t2.dump.enc', 's3://bucket/pfx/bk-t2.manifest.json', 's3://bucket/pfx/bk-t2.manifest.json.sha256']);
});

test('backup rechaza passphrase con permisos abiertos e id inválido antes de volcar nada, y un destino no soportado sin subir nada', (t) => {
  const base = { BACKUP_DB: 'beatgaler', BACKUP_TARGET: 'file://out', BACKUP_ID: 'bk-t3' };
  for (const [env, diagnostic] of [
    [{ ...base, FAKE_MODE: '644' }, /permisos 600/],
    [{ ...base, BACKUP_ID: '../x' }, /BACKUP_ID inválido/],
  ]) {
    const { result, calls } = runScript(t, 'pg-backup.sh', [], { env });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, diagnostic);
    assert.ok(!calls.some((c) => c.startsWith('pg_dump ') || c.startsWith('openssl ')));
  }
  const bad = runScript(t, 'pg-backup.sh', [], { env: { ...base, BACKUP_TARGET: 'ftp://x' } });
  assert.equal(bad.result.status, 2, bad.result.stderr);
  assert.match(bad.result.stderr, /BACKUP_TARGET no soportado/);
  assert.ok(!bad.calls.some((c) => c.startsWith('aws ')) && !fs.existsSync(path.join(bad.dir, 'out')));
});

test('restore: descifra, restaura sin dueños ni ACL con --exit-on-error, verifica contra el manifiesto y no sobrescribe', (t) => {
  const enc = 'FAKE-DUMP';
  const manifest = JSON.stringify({ dump: { sha256: sha(enc) }, encrypted: { sha256: sha(enc) }, migrations: { last: 'V9' }, counts: { users: 1, vaults: 2, legacy_beats: 3 } });
  const files = { 'bk-r.manifest.json': manifest, 'bk-r.manifest.json.sha256': `${sha(manifest)}  bk-r.manifest.json\n`, 'bk-r.dump.enc': enc };
  const env = { BACKUP_SOURCE: 'file://.' };
  // base existente: nunca se sobrescribe
  const exists = runScript(t, 'pg-restore.sh', ['bk-r', 'test_restore'], { env: { ...env, FAKE_DB_EXISTS: '1' }, files });
  assert.equal(exists.result.status, 4, exists.result.stderr);
  assert.match(exists.result.stderr, /no se sobrescribe/);
  assert.ok(!exists.calls.some((c) => c.startsWith('createdb ') || c.startsWith('pg_restore --no-owner')));
  // pg_restore falla: se elimina la base parcial
  const broken = runScript(t, 'pg-restore.sh', ['bk-r', 'test_restore'], { env: { ...env, FAKE_PGRESTORE_RC: '1' }, files });
  assert.equal(broken.result.status, 5, broken.result.stderr);
  assert.ok(broken.calls.includes('dropdb --if-exists test_restore'));
  assert.ok(broken.calls.some((c) => /^pg_restore --no-owner --no-acl --exit-on-error -d test_restore /.test(c)));
  assert.ok(broken.calls.some((c) => /^openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass file:\.\/pass /.test(c)));
  // verificación contra el manifiesto: recuento distinto => restore NO verificado
  const mismatch = runScript(t, 'pg-restore.sh', ['bk-r', 'test_restore'], { env: { ...env, FAKE_LAST: 'V8' }, files });
  assert.equal(mismatch.result.status, 6, mismatch.result.stderr);
  assert.match(mismatch.result.stderr, /VERIFICACIÓN FALLIDA/);
  // camino feliz
  const ok = runScript(t, 'pg-restore.sh', ['bk-r', 'test_restore'], { env, files });
  assert.equal(ok.result.status, 0, ok.result.stderr);
  assert.match(ok.result.stdout, /restore verificado id=bk-r base=test_restore/);
  assert.ok(!ok.calls.includes('dropdb --if-exists test_restore'));
});

test('restore rechaza un destino inseguro y un manifiesto corrupto antes de descifrar o tocar PostgreSQL', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-restore-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const encrypted = 'fixture';
  const manifest = {
    encrypted: { sha256: createHash('sha256').update(encrypted).digest('hex') },
    dump: { sha256: '1'.repeat(64) },
  };
  fs.writeFileSync(path.join(dir, 'fake-passphrase'), 'fixture');
  fs.writeFileSync(path.join(dir, 'bk-test.manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, 'bk-test.manifest.json.sha256'), '0'.repeat(64) + '  bk-test.manifest.json\n');
  fs.writeFileSync(path.join(dir, 'bk-test.dump.enc'), encrypted);

  const script = path.join(root, 'scripts/backup/pg-restore.sh').split(path.sep).join('/');
  const guardedRestore = [
    'export PATH=/usr/bin:/bin',
    'unexpected() { printf "UNEXPECTED_TOOL %s\\n" "$1" >&2; exit 99; }',
    'for tool in psql createdb dropdb pg_restore openssl aws node; do',
    '  eval "$tool() { unexpected $tool; }"',
    'done',
    'source "$1" bk-test "$2"',
  ].join('\n');
  const env = {
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    BACKUP_SOURCE: 'file://.',
    BACKUP_PASSPHRASE_FILE: './fake-passphrase',
  };
  for (const [db, exit, diagnostic] of [
    ['production', 2, /BASE_DESTINO.*restore/],
    ['test_restore', 3, /MANIFIESTO CORRUPTO/],
  ]) {
    const result = spawnSync('bash', ['--noprofile', '--norc', '-c', guardedRestore, 'restore-test', script, db], {
      cwd: dir, env, encoding: 'utf8', timeout: 30_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, exit, result.stderr);
    assert.match(result.stderr, diagnostic);
    assert.doesNotMatch(result.stderr, /UNEXPECTED_TOOL/);
  }
});
