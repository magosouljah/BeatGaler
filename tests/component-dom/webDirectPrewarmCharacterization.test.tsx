// @vitest-environment jsdom
/**
 * M1.B2a - Caracterizacion (fakes) del precalentamiento Direct Web en login, sesion recordada y logout.
 *
 * Usa la plataforma Web, AccountGate/AuthExperienceGate y el puerto Direct B reales, con un constructor
 * `Worker` falso, `fetch` falso del Cloud y orden logico de eventos
 * (no hay reloj de pared: "mismo instante" = misma posicion en el registro de eventos respecto a las peticiones del Cloud).
 *
 * Cada aserto marcado `COMPORTAMIENTO ACTUAL` fija un instante o recuento que M1.B2 debe conservar o justificar (D7:
 * el primer play tras entrar no empeora). No es evidencia de proveedor real: la latencia real queda para A3.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AuthExperienceGate from "../../src/features/auth/AuthExperienceGate";
import { setActiveWebAccountId } from "../../src/features/auth/activeWebAccount";
import { loginBeatGalerAccount } from "../../src/features/auth/webSignIn";
import { logoutBeatGalerAccount, restoreBeatGalerSession } from "../../src/features/auth/webSession";
import { createWebDirectPort, discardPrewarmedDirectRuntime, prewarmDirectRuntime } from "../../src/features/library/catalog/catalogDirectPort";
import { webAdapter } from "../../src/platform/webAdapter";

const { prepareTempAuth } = vi.hoisted(() => ({ prepareTempAuth: vi.fn(async () => { throw new Error("unexpected MTProto handshake"); }) }));
vi.mock("../../src/features/cloud/webTempAuth", () => ({ prepareWebTempAuth: prepareTempAuth }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const API = `${window.location.origin}/beatgaler-api`;
const MARKER_KEY = "beatgaler:web-session-present:v1";
const CSRF_SESSION_KEY = "beatgaler:web-csrf:v1";
const CSRF_COOKIE = "__Host-beatgaler_csrf";
const FORBIDDEN = ["bot_token", "api_hash", "auth_key", "permanent_key", "credential_envelope"];

// ---------------------------------------------------------------- dobles

const events: string[] = [];

class FakeWorker {
  static instances: FakeWorker[] = [];
  readonly id: number;
  readonly url: string;
  readonly options: unknown;
  readonly messages: Array<{ op?: string; [k: string]: unknown }> = [];
  terminated = false;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string | URL, options?: unknown) {
    this.id = FakeWorker.instances.length + 1;
    this.url = String(url);
    this.options = options;
    FakeWorker.instances.push(this);
    events.push(`worker:${this.id}:create`);
  }
  postMessage(message: { op?: string; requestId?: string }) {
    this.messages.push(message);
    events.push(`worker:${this.id}:post:${message.op}`);
    // El cierre ordenado espera acuse; los demas mensajes no tienen respuesta en estas pruebas.
    if (message.op === "shutdown") queueMicrotask(() => this.onmessage?.({ data: { requestId: message.requestId, ok: true, result: undefined } }));
  }
  terminate() {
    this.terminated = true;
    events.push(`worker:${this.id}:terminate`);
  }
  get ops(): string[] { return this.messages.map(message => String(message.op)); }
}

interface FetchRecord { path: string; method: string; headerNames: string[]; csrf: string | null; credentials: string | undefined; body: string }
let fetchLog: FetchRecord[] = [];
const servedBodies: string[] = [];
let routes: Record<string, (record: FetchRecord) => Response | Promise<Response>> = {};
let allowPoisonedResponses = false;

const json = (body: unknown, status = 200) => {
  const text = JSON.stringify(body);
  if (!allowPoisonedResponses) servedBodies.push(text);
  return new Response(text, { status, headers: { "Content-Type": "application/json" } });
};

const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const path = url.startsWith(API) ? url.slice(API.length) : url;
  const headers = new Headers(init?.headers as HeadersInit | undefined);
  const record: FetchRecord = {
    path,
    method: String(init?.method || "GET"),
    headerNames: Array.from(headers.keys()).map(name => name.toLowerCase()).sort(),
    csrf: headers.get("x-beatgaler-csrf"),
    credentials: init?.credentials,
    body: typeof init?.body === "string" ? init.body : "",
  };
  fetchLog.push(record);
  events.push(`fetch:${path}`);
  const handler = routes[path];
  const response = handler ? await handler(record) : json({ error: `unrouted ${path}` }, 404);
  events.push(`fetch:${path}:response:${response.status}`);
  return response;
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const user = (id: string) => ({ id, username: id, email: `${id}@example.test`, storage_ready: true });
const workers = () => FakeWorker.instances;
const paths = () => fetchLog.map(record => record.path);
const idx = (event: string) => events.indexOf(event);

async function flush(times = 6) {
  for (let i = 0; i < times; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}

let cookieJar = "";
function setCsrfCookie(value: string | null) {
  // jsdom rechaza cookies __Host- sobre http: el valor que el navegador real expone se simula en document.cookie.
  cookieJar = value === null ? "" : `${CSRF_COOKIE}=${value}`;
}
function setOnline(value: boolean) { Object.defineProperty(navigator, "onLine", { configurable: true, value }); }

function rememberedSession(withCookie: boolean) {
  localStorage.setItem(MARKER_KEY, "1");
  setCsrfCookie(withCookie ? "csrf-cookie-token" : null);
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;

async function mountGate() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<AuthExperienceGate><div data-testid="app">app</div></AuthExperienceGate>); });
}
function setValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
async function submitLoginForm() {
  setValue(host!.querySelector<HTMLInputElement>("#auth-login-identifier")!, "owner@example.test");
  setValue(host!.querySelector<HTMLInputElement>("#auth-login-password")!, "correct horse battery");
  await act(async () => { host!.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
}

function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (item instanceof Uint8Array ? `bytes(${item.byteLength})` : typeof item === "bigint" ? String(item) : item)) ?? "";
}

beforeEach(() => {
  events.length = 0;
  fetchLog = [];
  servedBodies.length = 0;
  allowPoisonedResponses = false;
  FakeWorker.instances = [];
  routes = {};
  fakeFetch.mockClear();
  prepareTempAuth.mockClear();
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal("fetch", fakeFetch);
  localStorage.clear();
  sessionStorage.clear();
  Object.defineProperty(document, "cookie", { configurable: true, get: () => cookieJar, set: () => {} });
  setCsrfCookie(null);
  setOnline(true);
  delete (window as any).__TAURI_INTERNALS__;
  setActiveWebAccountId(null);
});

afterEach(async () => {
  // INV-DB en todos los escenarios: ni los mensajes al Worker, ni las peticiones del cliente, ni lo que el Cloud sirvio al cliente
  // contienen bot_token, api_hash ni claves permanentes.
  const outbound = serialize({ worker: workers().flatMap(worker => worker.messages), fetches: fetchLog });
  for (const word of FORBIDDEN) {
    expect(outbound, `INV-DB: mensaje saliente con ${word}`).not.toContain(word);
    for (const body of servedBodies) expect(body, `INV-DB: respuesta servida con ${word}`).not.toContain(word);
  }
  if (root) await act(async () => root!.unmount());
  host?.remove();
  host = null; root = null;
  await discardPrewarmedDirectRuntime();
  await webAdapter.cloudData.disconnect();
  setActiveWebAccountId(null);
  delete (window as any).__TAURI_INTERNALS__;
  delete (document as any).cookie;
  setOnline(true);
  vi.unstubAllGlobals();
});

describe("M1.B2a - precalentamiento Direct Web: caracterizacion con dobles", () => {
  it("E1 login desde la pantalla de acceso: un Worker nace ANTES de que /auth/login responda, sin mensajes ni otras peticiones", async () => {
    const loginReply = deferred<Response>();
    routes["/auth/login"] = () => loginReply.promise;
    await mountGate();
    expect(workers()).toHaveLength(0);
    // COMPORTAMIENTO ACTUAL (M1.B2 debe conservar o justificar): al montar la puerta sin sesion solo sale una consulta /auth/signup/status (sin Worker ni Direct).
    expect(paths()).toEqual(["/auth/signup/status"]);

    await submitLoginForm();
    await vi.waitFor(() => expect(paths()).toContain("/auth/login"));
    // COMPORTAMIENTO ACTUAL (M1.B2 debe conservar o justificar): con /auth/login aun sin responder ya existe exactamente 1 Worker.
    await vi.waitFor(() => expect(workers()).toHaveLength(1));
    expect(events).not.toContain("fetch:/auth/login:response:200");
    const [worker] = workers();
    // COMPORTAMIENTO ACTUAL (M1.B2 debe conservar o justificar): URL del script, tipo y nombre del Worker.
    expect(worker.url).toContain("webTransport.worker.ts");
    expect(worker.options).toEqual({ type: "module", name: "galer-cloud-data-plane" });
    // COMPORTAMIENTO ACTUAL: el precalentamiento solo construye el Worker: cero mensajes y cero peticiones antes de autenticar,
    // salvo el propio /auth/login (el login registra la peticion, sin /auth/session ni /transport/*).
    expect(worker.messages).toEqual([]);
    expect(paths()).toEqual(["/auth/signup/status", "/auth/login"]);
    expect(fetchLog[1].method).toBe("POST");
    expect(fetchLog[1].credentials).toBe("include");
    // COMPORTAMIENTO ACTUAL (M1.B2 debe conservar o justificar): orden observado: se emite /auth/login y a continuacion nace el Worker, ambos antes de la respuesta.
    expect(events.slice(-2)).toEqual(["fetch:/auth/login", "worker:1:create"]);

    loginReply.resolve(json({ user: user("usr_e1"), csrf_token: "csrf-from-login" }));
    await flush();
    expect(host!.querySelector('[data-testid="app"]')).not.toBeNull();
    // COMPORTAMIENTO ACTUAL: tras entrar sigue 1 solo Worker, sin mensajes, y con el catalogo activo no hay /transport/* ni /auth/session.
    expect(workers()).toHaveLength(1);
    expect(workers()[0].terminated).toBe(false);
    expect(workers()[0].messages).toEqual([]);
    expect(paths().filter(path => path.startsWith("/transport"))).toEqual([]);
    expect(paths()).not.toContain("/auth/session");
    expect(localStorage.getItem(MARKER_KEY)).toBe("1");
  });

  it("E1b el Worker del login y la peticion /auth/login quedan ordenados: el Worker no espera a la respuesta", async () => {
    const loginReply = deferred<Response>();
    routes["/auth/login"] = () => loginReply.promise;
    const pending = loginBeatGalerAccount("owner@example.test", "pw");
    await vi.waitFor(() => expect(workers()).toHaveLength(1));
    // COMPORTAMIENTO ACTUAL (M1.B2 debe conservar o justificar): Worker presente mientras /auth/login esta pendiente.
    expect(events).not.toContain("fetch:/auth/login:response:200");
    loginReply.resolve(json({ user: user("usr_e1b"), csrf_token: "c" }));
    await act(async () => { await pending; });
    expect(workers()).toHaveLength(1);
    // COMPORTAMIENTO ACTUAL (M1.B2 debe conservar o justificar): /auth/login se emite, luego nace el Worker, luego llega la respuesta.
    expect(idx("fetch:/auth/login")).toBeLessThan(idx("worker:1:create"));
    expect(idx("worker:1:create")).toBeLessThan(idx("fetch:/auth/login:response:200"));
  });

  it("E1c el precalentamiento de login es solo el Worker: no abre sesion Direct ni toca el Cloud", async () => {
    prewarmDirectRuntime({ accountId: null });
    await flush();
    // COMPORTAMIENTO ACTUAL (M1.B2 debe conservar o justificar): 1 Worker, 0 mensajes, 0 peticiones.
    expect(workers()).toHaveLength(1);
    expect(workers()[0].messages).toEqual([]);
    expect(fetchLog).toEqual([]);
  });

  it.each([
    ["con cookie CSRF visible", true],
    ["sin cookie CSRF", false],
  ])("E2 arranque con sesion recordada %s por la puerta de acceso: no crea ningun Worker", async (_label, withCookie) => {
    rememberedSession(withCookie);
    const sessionReply = deferred<Response>();
    routes["/auth/session"] = () => sessionReply.promise;
    await mountGate();
    await vi.waitFor(() => expect(paths()).toEqual(["/auth/session"]));
    // COMPORTAMIENTO ACTUAL (M1.B2 debe conservar o justificar): con /auth/session pendiente, 0 Workers (preconnectRememberedWebDirect
    // no tiene llamantes en src/; el arranque recordado no precalienta Direct en la puerta de acceso).
    expect(workers()).toHaveLength(0);
    sessionReply.resolve(json({ user: user("usr_e2") }));
    await flush();
    expect(host!.querySelector('[data-testid="app"]')).not.toBeNull();
    // COMPORTAMIENTO ACTUAL: sigue sin Worker ni peticiones /transport/* tras confirmar la sesion.
    expect(workers()).toHaveLength(0);
    expect(paths()).toEqual(["/auth/session"]);
  });

  it("el primer open adopta el Worker del login y solo el puerto lo cierra durante el logout", async () => {
    const loginReply = deferred<Response>();
    routes["/auth/login"] = () => loginReply.promise;
    const login = loginBeatGalerAccount("owner@example.test", "pw");
    await vi.waitFor(() => expect(workers()).toHaveLength(1));
    const [prewarmed] = workers();
    loginReply.resolve(json({ user: user("usr_adoption"), csrf_token: "c" }));
    await login;

    const reserveReply = deferred<Response>();
    routes["/catalog/v1/direct/session"] = () => reserveReply.promise;
    const port = createWebDirectPort();
    const opening = port.ready();
    const logoutReply = deferred<Response>();
    routes["/auth/logout"] = () => logoutReply.promise;
    let logout: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(paths()).toEqual(["/auth/login", "/catalog/v1/direct/session"]));
      expect(workers()).toEqual([prewarmed]);
      expect(prewarmed.messages).toEqual([]);

      logout = logoutBeatGalerAccount();
      await vi.waitFor(() => expect(paths()).toContain("/auth/logout"));
      await flush();
      expect(prewarmed.messages).toEqual([]);
      expect(prewarmed.terminated).toBe(false);

      // Simula el teardown de Gallery mientras la reserva de la sesión sigue en vuelo.
      const closing = port.close();
      reserveReply.resolve(json({ error: "service unavailable" }, 503));
      await closing;
      await expect(opening).resolves.toBe(false);
      expect(events).not.toContain("fetch:/auth/logout:response:200");
      expect(workers()).toEqual([prewarmed]);
      expect(prewarmed.ops).toEqual(["shutdown"]);
      expect(events.filter(event => event.endsWith(":terminate"))).toEqual(["worker:1:terminate"]);
      expect(idx("worker:1:terminate")).toBeGreaterThan(idx("worker:1:post:shutdown"));
    } finally {
      reserveReply.resolve(json({ error: "service unavailable" }, 503));
      logoutReply.resolve(json({ ok: true }));
      await port.close();
      await opening;
      await logout;
    }
    expect(events.filter(event => event.endsWith(":terminate"))).toEqual(["worker:1:terminate"]);
  });

  it("el primer open de otra cuenta descarta el Worker del login", async () => {
    routes["/auth/login"] = () => json({ user: user("usr_login"), csrf_token: "c" });
    await loginBeatGalerAccount("owner@example.test", "pw");
    await vi.waitFor(() => expect(workers()).toHaveLength(1));
    const [prewarmed] = workers();
    setActiveWebAccountId("usr_other");
    const reserveReply = deferred<Response>();
    routes["/catalog/v1/direct/session"] = () => reserveReply.promise;
    const port = createWebDirectPort();
    const opening = port.ready();
    try {
      await vi.waitFor(() => expect(prewarmed.terminated).toBe(true));
      expect(prewarmed.ops).toEqual(["shutdown"]);
      expect(paths()).toEqual(["/auth/login", "/catalog/v1/direct/session"]);
    } finally {
      reserveReply.resolve(json({ error: "service unavailable" }, 503));
      await opening;
      await port.close();
    }
    expect(events.filter(event => event.endsWith(":terminate"))).toEqual(["worker:1:terminate"]);
  });

  it("E4 logout con Worker vivo: shutdown + terminate sin esperar a /auth/logout; el siguiente login crea otro Worker", async () => {
    routes["/auth/login"] = () => json({ user: user("usr_e4"), csrf_token: "c" });
    await act(async () => { await loginBeatGalerAccount("owner@example.test", "pw"); });
    expect(workers()).toHaveLength(1);

    const logoutReply = deferred<Response>();
    routes["/auth/logout"] = () => logoutReply.promise;
    const pending = logoutBeatGalerAccount();
    // Efecto sincrono: la cuenta se oculta y la marca recordada se borra antes de cualquier peticion.
    expect(localStorage.getItem(MARKER_KEY)).toBeNull();
    await vi.waitFor(() => expect(workers()[0].terminated).toBe(true));
    // COMPORTAMIENTO ACTUAL (M1.B2 debe conservar o justificar): el Worker se cierra (mensaje "shutdown", luego terminate) mientras
    // /auth/logout sigue pendiente: ambos corren en paralelo.
    expect(workers()[0].ops).toEqual(["shutdown"]);
    expect(events).toContain("fetch:/auth/logout");
    expect(events).not.toContain("fetch:/auth/logout:response:200");
    expect(workers()).toHaveLength(1);

    logoutReply.resolve(json({ ok: true }));
    await act(async () => { await pending; });
    expect(sessionStorage.getItem(CSRF_SESSION_KEY)).toBeNull();

    routes["/auth/login"] = () => json({ user: user("usr_e4b"), csrf_token: "c2" });
    await act(async () => { await loginBeatGalerAccount("owner@example.test", "pw"); });
    // COMPORTAMIENTO ACTUAL: el nuevo login crea un SEGUNDO Worker; el primero sigue terminado y sin mas mensajes.
    expect(workers()).toHaveLength(2);
    expect(workers()[0].terminated).toBe(true);
    expect(workers()[0].ops).toEqual(["shutdown"]);
    expect(workers()[1].terminated).toBe(false);
    expect(workers()[1].messages).toEqual([]);
  });

  it("E4b logout sin Worker previo: no crea ninguno ni envia shutdown", async () => {
    localStorage.setItem(MARKER_KEY, "1");
    routes["/auth/logout"] = () => json({ ok: true });
    await act(async () => { await logoutBeatGalerAccount(); });
    // COMPORTAMIENTO ACTUAL (M1.B2 debe conservar o justificar): cerrar no construye un Worker.
    expect(workers()).toHaveLength(0);
    expect(paths()).toEqual(["/auth/logout"]);
  });

  it("E5 expiracion de sesion (401): cierra el Worker existente, limpia la marca y no crea otro", async () => {
    routes["/auth/login"] = () => json({ user: user("usr_e5"), csrf_token: "c" });
    await act(async () => { await loginBeatGalerAccount("owner@example.test", "pw"); });
    expect(workers()).toHaveLength(1);
    routes["/auth/session"] = () => json({ error: "Session expired.", code: "SESSION_EXPIRED" }, 401);

    let restored: unknown = "pending";
    await act(async () => { restored = await restoreBeatGalerSession(); });
    await vi.waitFor(() => expect(workers()[0].terminated).toBe(true));
    // COMPORTAMIENTO ACTUAL (M1.B2 debe conservar o justificar): la expiracion dispara el mismo cierre que el logout (shutdown + terminate),
    // sin llamar a /auth/logout, y no crea Workers nuevos.
    expect(restored).toBeNull();
    expect(workers()).toHaveLength(1);
    expect(workers()[0].ops).toEqual(["shutdown"]);
    expect(paths()).not.toContain("/auth/logout");
    expect(localStorage.getItem(MARKER_KEY)).toBeNull();
  });

  it("E5b expiracion con sesion recordada y sin Worker: no construye ni cierra nada", async () => {
    rememberedSession(true);
    routes["/auth/session"] = () => json({ error: "no" }, 401);
    let restored: unknown = "pending";
    await act(async () => { restored = await restoreBeatGalerSession(); });
    await flush();
    expect(restored).toBeNull();
    expect(workers()).toHaveLength(0);
    expect(paths()).toEqual(["/auth/session"]);
    expect(localStorage.getItem(MARKER_KEY)).toBeNull();
  });

  it("E5c un fallo de red/servidor (no 401) NO cierra el Worker ni borra la marca", async () => {
    routes["/auth/login"] = () => json({ user: user("usr_e5c"), csrf_token: "c" });
    await act(async () => { await loginBeatGalerAccount("owner@example.test", "pw"); });
    routes["/auth/session"] = () => json({ error: "boom" }, 500);
    await act(async () => { await expect(restoreBeatGalerSession()).rejects.toBeTruthy(); });
    await flush();
    // COMPORTAMIENTO ACTUAL (M1.B2 debe conservar o justificar): solo la expiracion confirmada desconecta.
    expect(workers()).toHaveLength(1);
    expect(workers()[0].terminated).toBe(false);
    expect(workers()[0].messages).toEqual([]);
    expect(localStorage.getItem(MARKER_KEY)).toBe("1");
  });

  it("E6 navegador sin conexion: ni login ni sesion recordada crean Worker; el login igualmente intenta /auth/login", async () => {
    setOnline(false);
    routes["/auth/login"] = () => json({ user: user("usr_e6"), csrf_token: "c" });
    await act(async () => { await loginBeatGalerAccount("owner@example.test", "pw"); });
    await flush();
    // COMPORTAMIENTO ACTUAL (M1.B2 debe conservar o justificar): offline solo se omite el precalentamiento; la peticion de login no se bloquea.
    expect(workers()).toHaveLength(0);
    expect(paths()).toEqual(["/auth/login"]);

    fetchLog = [];
    rememberedSession(true);
    routes["/auth/session"] = () => json({ user: user("usr_e6") });
    await mountGate();
    await flush();
    expect(workers()).toHaveLength(0);
    expect(paths()).toEqual(["/auth/session"]);
  });

  it("E7 entorno Tauri: el precalentamiento no crea Worker ni peticiones", async () => {
    (window as any).__TAURI_INTERNALS__ = {};
    rememberedSession(true);
    routes["/auth/login"] = () => json({ user: user("usr_e7"), csrf_token: "c" });
    await act(async () => { await loginBeatGalerAccount("owner@example.test", "pw"); });
    await flush();
    // COMPORTAMIENTO ACTUAL (M1.B2 debe conservar o justificar): 0 Workers; solo la peticion de login.
    expect(workers()).toHaveLength(0);
    expect(paths()).toEqual(["/auth/login"]);
  });

  describe("INV-DB", () => {
    const bootstrapBase = {
      mode: "galer-direct-temp-mtproto",
      session_id: "s1", generation: 1, credential_version: 1, transport_id: "t1", chat_id: -100123,
      temp_auth: { dc_id: 2, api_id: 12345, expected_bot_id: "777" },
    };

    it.each([
      ["bot_token", { ...bootstrapBase, bot_token: "123:SECRET" }],
      ["telegram_api_hash", { ...bootstrapBase, telegram_api_hash: "abcdef" }],
      ["credential_envelope", { ...bootstrapBase, credential_envelope: "x" }],
    ])("una respuesta del Cloud con %s es rechazada y no llega al Worker", async (_name, poisoned) => {
      allowPoisonedResponses = true;
      routes["/auth/login"] = () => json({ user: user("usr_inv"), csrf_token: "c" });
      routes["/catalog/v1/direct/session"] = () => json(poisoned);
      routes["/catalog/v1/direct/session/stop"] = () => json({ ok: true });
      await loginBeatGalerAccount("owner@example.test", "pw");
      await vi.waitFor(() => expect(workers()).toHaveLength(1));
      const port = createWebDirectPort();
      await expect(port.ready()).resolves.toBe(false);
      expect(workers()[0].terminated).toBe(true);
      // El cliente se niega a usarla: el Worker solo recibe el cierre, nunca initialize ni la respuesta envenenada.
      expect(workers()[0].ops).toEqual(["shutdown"]);
      const sent = serialize(workers()[0].messages);
      expect(sent).not.toContain("SECRET");
      expect(sent).not.toContain("abcdef");
      expect(prepareTempAuth).not.toHaveBeenCalled();
      expect(paths()).toEqual(["/auth/login", "/catalog/v1/direct/session", "/catalog/v1/direct/session/stop"]);
    });
  });
});
