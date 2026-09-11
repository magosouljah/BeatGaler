'use strict';

const fs = require('node:fs');
const file = 'package.json';
const source = fs.readFileSync(file, 'utf8');
const needle = 'node cloud-server/tests/direct-persistent-membership-runtime.test.cjs && node cloud-server/tests/direct-persistent-ready-no-master.test.cjs';
const replacement = 'node cloud-server/tests/direct-persistent-membership-runtime.test.cjs && node cloud-server/tests/direct-membership-provisioning-primitive.test.cjs && node cloud-server/tests/direct-persistent-ready-no-master.test.cjs';
const count = source.split(needle).length - 1;
if (count !== 1) throw new Error(`Expected exactly one Direct membership test sequence, found ${count}.`);
fs.writeFileSync(file, source.replace(needle, replacement), 'utf8');
