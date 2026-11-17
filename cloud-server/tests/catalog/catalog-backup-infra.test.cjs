'use strict';
// G4: la plantilla S3 y los scripts de backup/restore cumplen las propiedades de seguridad exigidas (sin tocar AWS ni PostgreSQL).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
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

test('scripts: sintaxis bash válida, guardas de seguridad y ningún secreto en claro', () => {
  for (const f of ['pg-backup.sh', 'pg-restore.sh', 'pg-drill.sh']) {
    execFileSync('bash', ['-n', path.join(root, 'scripts/backup', f)]);
    const s = read(`scripts/backup/${f}`);
    assert.doesNotMatch(s, /AKIA[0-9A-Z]{16}|aws_secret_access_key|PGPASSWORD=|password=\S/i, `${f} contiene un secreto`);
  }
  const restore = read('scripts/backup/pg-restore.sh'); const backup = read('scripts/backup/pg-backup.sh');
  assert.match(restore, /contener 'restore'/); assert.match(restore, /no se sobrescribe/); assert.match(restore, /sha256sum -c/); assert.match(restore, /--exit-on-error/); assert.match(restore, /dropdb --if-exists/);
  assert.match(backup, /aes-256-cbc -pbkdf2 -iter 600000/); assert.match(backup, /--sse aws:kms/); assert.match(backup, /permisos 600/);
  assert.match(backup, /NO respalda los bytes/);
  assert.match(read('deploy/backup/README.md'), /S3 \*\*no\*\* respalda los audios/);
});
