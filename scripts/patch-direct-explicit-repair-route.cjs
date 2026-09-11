'use strict';

const fs = require('node:fs');
const file = 'cloud-server/server-core.js';
const source = fs.readFileSync(file, 'utf8');
const needle = `    const result = await directTransport.activateSession({
      startupTrace,
      installationId: beatgalerUserId,
      sessionId: String(req.body?.sessionId || ""),
      generation: Number(req.body?.generation || 0),
    });`;
const replacement = `    const activationMethod = req.body?.repairMembership === true ? "repairMembership" : "activateSession";
    if (typeof directTransport[activationMethod] !== "function") {
      throw new Error("Requested Direct membership repair is unavailable.");
    }
    const result = await directTransport[activationMethod]({
      startupTrace,
      installationId: beatgalerUserId,
      sessionId: String(req.body?.sessionId || ""),
      generation: Number(req.body?.generation || 0),
    });`;
const count = source.split(needle).length - 1;
if (count !== 1) throw new Error(`Expected exactly one Direct activate route body, found ${count}.`);
fs.writeFileSync(file, source.replace(needle, replacement), 'utf8');
