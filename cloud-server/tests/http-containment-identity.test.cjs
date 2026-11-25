'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { sha256String, accountsDataPath } = require('../auth-helpers');
const { createHttpContainment } = require('../http-containment');
const { installLegacyJsonCompatibility } = require('../control-plane-json-compat');
const { virtualIdentity } = require('../identity-store');

const now = 1_800_000_000_000;
const token = 'containment-token';
const hash = sha256String(token);
const INSTALLATION = 'inst-1';

function store(userId, email, { expiresAt = now + 1000, extraUsers = [] } = {}) {
  return {
    users: [{ id: userId, email, providers: { x: { id: 'px' } } }, ...extraUsers],
    sessions: { [hash]: { userId, expiresAt, installationId: INSTALLATION, details: { c: 1 } } },
  };
}

function fixture(t, { virtual, initial = store('usr_a', 'A@Example.test') } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-containment-id-'));
  const file = accountsDataPath(dir);
  const persistent = path.join(dir, 'cloud-data.json');
  const cloud = { linkedAccounts: { [INSTALLATION]: { beatgalerAccountId: 'usr_a' } }, beatTopics: {} };
  let uninstall;
  t.after(() => { uninstall?.(); fs.rmSync(dir, { recursive: true, force: true }); });
  if (virtual) {
    uninstall = installLegacyJsonCompatibility({
      fsModule: fs, authPath: file, persistentPath: persistent, initialAuth: initial, initialPersistent: cloud,
      runtime: { saveAuthSnapshot() {}, savePersistentSnapshot() {} },
    });
  } else {
    fs.writeFileSync(file, JSON.stringify(initial));
    fs.writeFileSync(persistent, JSON.stringify(cloud));
  }
  const containment = createHttpContainment({ dataDir: dir, env: {}, now: () => now });
  // Devuelve la función que publica el cambio (en virtual, el rename confirma).
  const commit = value => {
    if (virtual) {
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(value));
      return () => fs.renameSync(`${file}.tmp`, file);
    }
    fs.writeFileSync(file, JSON.stringify(value));
    return () => {};
  };
  return { dir, file, containment, commit };
}

function response() {
  const res = { statusCode: 200, body: null };
  res.status = code => { res.statusCode = code; return res; };
  res.json = body => { res.body = body; return res; };
  res.once = () => {};
  return res;
}

const request = (extra = {}) => ({ headers: { authorization: `Bearer ${token}` }, body: {}, ...extra });

for (const virtual of [true, false]) {
  const mode = virtual ? 'virtual' : 'json';

  test(`authenticate decide sesión, vencimiento y usuario como hoy (${mode})`, t => {
    const f = fixture(t, { virtual });
    const ok = f.containment.authenticate(request(), response());
    assert.equal(ok.key, hash);
    assert.equal(ok.user.id, 'usr_a');
    assert.equal(ok.session.userId, 'usr_a');

    let res = response();
    assert.equal(f.containment.authenticate({ headers: { authorization: 'Bearer other' }, body: {} }, res), null);
    assert.equal(res.statusCode, 401);

    f.commit(store('usr_a', 'a@example.test', { expiresAt: now }))();
    res = response();
    assert.equal(f.containment.authenticate(request(), res), null, 'expiresAt == now está vencida');
    assert.equal(res.statusCode, 401);

    const orphan = store('usr_a', 'a@example.test');
    orphan.sessions[hash].userId = 'usr_missing';
    f.commit(orphan)();
    res = response();
    assert.equal(f.containment.authenticate(request(), res), null, 'sesión sin usuario');
    assert.equal(res.statusCode, 401);
  });

  test(`un cambio del almacén se ve en la petición siguiente solo tras confirmar (${mode})`, t => {
    const f = fixture(t, { virtual });
    assert.equal(f.containment.authenticate(request(), response()).user.id, 'usr_a');
    const publish = f.commit(store('usr_b', 'b@example.test'));
    if (virtual) assert.equal(f.containment.authenticate(request(), response()).user.id, 'usr_a', 'staged no es visible');
    publish();
    assert.equal(f.containment.authenticate(request(), response()).user.id, 'usr_b');
    // La instalación sigue enlazada a usr_a, que ya no existe: enlace huérfano.
    assert.equal(f.containment.authorizeSessionInstallation(request(), response()), null);
  });

  test(`enlace huérfano, propietario y candidato de login se resuelven por el almacén (${mode})`, async t => {
    const extra = [{ id: 'usr_c', email: 'c@example.test', providers: { x: { id: 'px' } } }];
    const f = fixture(t, { virtual, initial: store('usr_a', 'A@Example.test', { extraUsers: extra }) });
    const good = f.containment.authorizeSessionInstallation(request(), response());
    assert.equal(good.account.beatgalerAccountId, 'usr_a');

    // findLoginUser: el correo se normaliza; otro dueño de la instalación => 403.
    let res = response(); let nexted = false;
    await f.containment.guardLoginInstallation({ body: { beatgalerUserId: INSTALLATION, email: ' C@Example.TEST ' } }, res, () => { nexted = true; });
    assert.equal(res.statusCode, 403);
    assert.equal(nexted, false);
    res = response(); nexted = false;
    await f.containment.guardLoginInstallation({ body: { beatgalerUserId: INSTALLATION, identifier: 'A@example.test' } }, res, () => { nexted = true; });
    assert.equal(nexted, true);

    // guardOAuthStart sin token: el dueño debe tener el proveedor vinculado.
    res = response(); nexted = false;
    f.containment.guardOAuthStart({ headers: {}, body: { beatgalerUserId: INSTALLATION, provider: 'x' } }, res, () => { nexted = true; });
    assert.equal(nexted, true);
    res = response(); nexted = false;
    f.containment.guardOAuthStart({ headers: {}, body: { beatgalerUserId: INSTALLATION, provider: 'google' } }, res, () => { nexted = true; });
    assert.equal(res.statusCode, 403);
    assert.equal(nexted, false);

    // Con el dueño presente, registrar la instalación se rechaza.
    res = response(); nexted = false;
    await f.containment.guardRegisterInstallation({ body: { beatgalerUserId: INSTALLATION, email: 'n@example.test' } }, res, () => { nexted = true; });
    assert.equal(res.statusCode, 403);
    assert.equal(nexted, false);

    f.commit(store('usr_c', 'c@example.test'))();
    assert.equal(f.containment.authorizeSessionInstallation(request(), response()), null);
    // Enlace huérfano (su dueño ya no existe): no bloquea un registro nuevo.
    res = response(); nexted = false;
    await f.containment.guardRegisterInstallation({ body: { beatgalerUserId: INSTALLATION, email: 'n@example.test' } }, res, () => { nexted = true; });
    assert.equal(nexted, true);
  });

  test(`bindSessionInstallation exige sesión del propietario esperado (${mode})`, t => {
    const f = fixture(t, { virtual });
    assert.equal(f.containment.bindSessionInstallation(token, INSTALLATION, 'usr_a'), true);
    assert.equal(f.containment.bindSessionInstallation(token, INSTALLATION, 'usr_b'), false);
    assert.equal(f.containment.bindSessionInstallation('otro', INSTALLATION, 'usr_a'), false);
  });
}

test('authenticate entrega copias aisladas del índice virtual', t => {
  const f = fixture(t, { virtual: true });
  const first = f.containment.authenticate(request(), response());
  first.user.providers.x.id = 'mutado';
  first.session.details.c = 99;
  const second = f.containment.authenticate(request(), response());
  assert.equal(second.user.providers.x.id, 'px');
  assert.equal(second.session.details.c, 1);
  assert.equal(virtualIdentity(fs, f.file).userById('usr_a').providers.x.id, 'px');
});

test('una escritura directa sin rename al archivo final se lee por la vía heredada', t => {
  const f = fixture(t, { virtual: true });
  fs.writeFileSync(f.file, JSON.stringify(store('usr_direct', 'direct@example.test')));
  assert.equal(f.containment.authenticate(request(), response()).user.id, 'usr_direct');
});
