import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { installLegacyMediaUploadDisable } = require("../cloud-server/legacy-media-upload-disable.js");
const { createGuardContext, mountAccountRouteGuards } =require("../cloud-server/account-route-guards.js");
const { installHttpContainment } = require("../cloud-server/http-containment.js");

const registered = [];
const fakeExpress = { application: {} };
fakeExpress.application.post = function(route, ...handlers) {
  registered.push({ route, handlers });
  return this;
};
fakeExpress.application.get = function() { return this; };

const guardContext = createGuardContext();
installLegacyMediaUploadDisable(guardContext);
installHttpContainment(guardContext, { dataDir: process.cwd(), env: { NODE_ENV: "test" } });
const app = Object.create(fakeExpress.application);
mountAccountRouteGuards(app, undefined, guardContext);

const multer = () => {};
const handler = () => {};
for (const route of ["/beats/upload", "/projects/upload", "/cloud-files/upload"]) {
  app.post(route, multer, handler);
  const entry = registered.find(item => item.route === route);
  assert.ok(entry, `legacy route ${route} must be registered`);
  assert.equal(entry.handlers.length, 1, `${route} must be replaced before Multer`);
  assert.notEqual(entry.handlers[0], multer, `${route} must not execute Multer`);
  const res = {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
  entry.handlers[0]({}, res);
  assert.equal(res.statusCode, 410, `${route} must fail closed as legacy`);
}

app.post("/metadata/artwork", multer, handler);
const artwork = registered.find(item => item.route === "/metadata/artwork");
assert.equal(artwork.handlers.length, 4, "active metadata upload must keep containment + Multer path");
assert.notEqual(artwork.handlers[0], multer, "active metadata upload must authorize before Multer");

console.log("PASS legacy HTTP media uploads are disabled before Multer; Direct remains the media data plane");
