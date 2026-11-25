'use strict';
// Guarda ESTÁTICA con nombre (intencional, cuenta en F+M): los scripts de backup/restore versionados no contienen secretos
// ni políticas prohibidas: sin clave AWS literal, sin aws_secret_access_key (rol IAM), sin PGPASSWORD= (PGPASSFILE), sin password=valor.
// El comportamiento de los scripts se prueba aparte en catalog-backup-infra.test.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..', '..');
const SECRET = /AKIA[0-9A-Z]{16}|aws_secret_access_key|PGPASSWORD=|password=\S/i;
const SCRIPTS = [
  'scripts/backup/pg-backup.sh', 'scripts/backup/pg-restore.sh', 'scripts/backup/pg-drill.sh',
  'scripts/backup/pg-backup-s3-kms.sh', 'scripts/backup/pg-restore-s3-kms.sh',
];

test('los scripts de backup/restore versionados no contienen secretos en claro', () => {
  for (const f of SCRIPTS) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, f), 'utf8'), SECRET, `${f} contiene un secreto`);
  }
});
