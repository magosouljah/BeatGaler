import { readFileSync, writeFileSync } from "node:fs";

const path = "src/features/cloud/webTransportWorkerClient.ts";
const source = readFileSync(path, "utf8");
const before = `        temp_auth_key: session.temp_auth_key,\n        temp_primary_dcs: session.temp_primary_dcs,`;
const after = `        temp_auth_key: session.temp_auth_key,\n        temp_session_id: session.temp_session_id,\n        temp_primary_dcs: session.temp_primary_dcs,`;
const first = source.indexOf(before);
if (first < 0) throw new Error("Missing worker-client temp-auth patch anchor.");
if (source.indexOf(before, first + before.length) >= 0) throw new Error("Worker-client temp-auth patch anchor is not unique.");
writeFileSync(path, source.slice(0, first) + after + source.slice(first + before.length));
console.log("APPLY_WORKER_CLIENT_SESSION_ID=PASS");
