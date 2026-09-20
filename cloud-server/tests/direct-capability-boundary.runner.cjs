'use strict';

const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === '../direct-capability-boundary' || request === '../direct-capability-boundary.js') {
    // Let the boundary module load, but stub only its Direct provider dependency.
  }
  if (request === './direct-transport-control' && /direct-capability-(boundary|view)\.js$/.test(String(parent?.filename || ''))) {
    return { endOperation: async () => ({ ok: true }), recordDiagnostic: () => {} };
  }
  return originalLoad.call(this, request, parent, isMain);
};

try {
  require('./direct-capability-boundary.test.cjs');
  require('./sensitive-auth-capability-revocation.test.cjs');
} finally {
  Module._load = originalLoad;
}
