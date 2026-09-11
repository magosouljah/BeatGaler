'use strict';

const fs = require('node:fs');
const file = 'cloud-server/direct-transport-control.js';
const source = fs.readFileSync(file, 'utf8');
const needle = `    leasesForBot,
    activeOpsForBot,
  },`;
const replacement = `    leasesForBot,
    activeOpsForBot,
    inviteAndPromote,
  },`;
const count = source.split(needle).length - 1;
if (count !== 1) throw new Error(`Expected exactly one Direct __test export block, found ${count}.`);
fs.writeFileSync(file, source.replace(needle, replacement), 'utf8');
