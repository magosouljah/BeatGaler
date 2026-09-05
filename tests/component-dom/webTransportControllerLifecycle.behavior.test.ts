import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WebTransportController,
  type WebTransportControlApi,
  type WebTransportRuntime,
} from "../../src/features/cloud/webTransportController";
import type { WebTransportSession, WebTransportSessionPublic } from "../../src/features/cloud/webTransportSession";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function bootstrap(version = 1): WebTransportSessionPublic {
  return {
    mode: "galer-direct-temp-mtproto",
    session_id: "session-1",
    transport_id: "transport-1",
    transport_user_id: "101",
    transport_username: "transport_bot",
    chat_id: "-100123",
    resolver_chat_id: null,
    generation: 7,
    credential_version: version,
    heartbeat_interval_ms: 1000,
    heartbeat_timeout_ms: 300_000,
    token_rotation_enabled: false,
    temp_auth_required: true,
    temp_auth: {
      version: 1,
      dc_id: 2,
      api_id: 12345,
      expected_bot_id: "101",
      expires_at: null,
      binding: null,
    },
  };
}

function session(version = 1): WebTransportSession {
  return {
    ...bootstrap(version),
    temp_auth_required: false,
    temp_auth: {
      ...bootstrap(version).temp_auth,
      expires_at: 2_000_000_000,
      binding: {} as WebTransportSession["temp_auth"]["binding"],
    },
    temp_auth_key: new Uint8Array(256).fill(version),
    temp_session_id: { low: version, high: 0, unsigned: true },
    temp_session_state: {} as WebTransportSession["temp_session_state"],
    temp_primary_dcs: { main: { id: 2 } },
  } as WebTransportSession;
}

function harness() {
  const runtime: WebTransportRuntime = {
    initialize: vi.fn(async () => {}),
    replaceCredentials: vi.fn(async () => {}),
    verifyIdentity: vi.fn(async () => {}),
    verifyReady: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
  };
  const api: WebTransportControlApi = {
    reserve: vi.fn(async () => bootstrap()),
    bind: vi.fn(async () => session()),
    activate: vi.fn(async () => {}),
    heartbeat: vi.fn(async () => ({ expired: false, credentialRefresh: null })),
    authorize: vi.fn(async () => {}),
    begin: vi.fn(async () => ({ expired: false, waitMs: null, credentialRefresh: null, operationId: "op-1" })),
    end: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
  return { runtime, api, controller: new WebTransportController(runtime, api) };
}

describe("WebTransportController lifecycle behavior", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("resolves playback connect while getMe/getChat remain pending and blocks writes until both finish", async () => {
    const { runtime, api, controller } = harness();
    const identity = deferred<void>();
    const chat = deferred<void>();
    vi.mocked(runtime.verifyIdentity).mockReturnValue(identity.promise);
    vi.mocked(runtime.verifyReady).mockReturnValue(chat.promise);

    const connected = await controller.connect();
    expect(connected.session_id).toBe("session-1");
    expect(runtime.verifyIdentity).toHaveBeenCalledOnce();
    expect(runtime.verifyReady).toHaveBeenCalledOnce();

    const write = controller.beginOperation("commit_edit", { objectType: "beat", objectIds: ["beat-1"] });
    await Promise.resolve();
    expect(api.begin).not.toHaveBeenCalled();
    expect(api.authorize).not.toHaveBeenCalled();

    identity.resolve();
    await Promise.resolve();
    expect(api.begin).not.toHaveBeenCalled();
    chat.resolve();

    await expect(write).resolves.toMatchObject({ operationId: "op-1" });
    expect(api.begin).toHaveBeenCalledOnce();
    expect(api.authorize).toHaveBeenCalledOnce();
    await controller.disconnect();
  });

  it.each(["identity", "chat"] as const)("fails closed when background %s verification fails after playback readiness", async failed => {
    const { runtime, api, controller } = harness();
    const identity = deferred<void>();
    const chat = deferred<void>();
    vi.mocked(runtime.verifyIdentity).mockReturnValue(identity.promise);
    vi.mocked(runtime.verifyReady).mockReturnValue(chat.promise);

    await expect(controller.connect()).resolves.toMatchObject({ session_id: "session-1" });
    if (failed === "identity") {
      identity.reject(new Error("getMe failed"));
      chat.resolve();
    } else {
      identity.resolve();
      chat.reject(new Error("getChat failed"));
    }

    await vi.waitFor(() => expect(runtime.shutdown).toHaveBeenCalled());
    expect(api.stop).toHaveBeenCalledWith(expect.objectContaining({ session_id: "session-1" }));
    await expect(controller.beginOperation("commit_edit", { objectType: "beat", objectIds: ["beat-1"] }))
      .rejects.toThrow();
    expect(api.authorize).not.toHaveBeenCalled();
  });

  it("does not publish a late session when logout wins during reserve", async () => {
    const { runtime, api, controller } = harness();
    const reservation = deferred<WebTransportSessionPublic>();
    vi.mocked(api.reserve).mockReturnValue(reservation.promise);

    const connect = controller.connect();
    const disconnect = controller.disconnect();
    reservation.resolve(bootstrap());

    await expect(connect).rejects.toThrow("superseded");
    await disconnect;
    expect(api.bind).not.toHaveBeenCalled();
    expect(runtime.initialize).not.toHaveBeenCalled();
    await expect(controller.connect()).rejects.toThrow("closed");
  });

  it("does not publish a late session when logout wins during bind/activate", async () => {
    const { runtime, api, controller } = harness();
    const binding = deferred<WebTransportSession>();
    const activation = deferred<void>();
    vi.mocked(api.bind).mockReturnValue(binding.promise);
    vi.mocked(api.activate).mockReturnValue(activation.promise);

    const connect = controller.connect();
    await vi.waitFor(() => expect(api.bind).toHaveBeenCalledOnce());
    const disconnect = controller.disconnect();
    binding.resolve(session());
    activation.resolve();

    await expect(connect).rejects.toThrow("superseded");
    await disconnect;
    expect(runtime.initialize).not.toHaveBeenCalled();
    expect(runtime.verifyIdentity).not.toHaveBeenCalled();
  });

  it("does not publish a late session when logout wins during Worker initialize", async () => {
    const { runtime, controller } = harness();
    const initialize = deferred<void>();
    vi.mocked(runtime.initialize).mockReturnValue(initialize.promise);

    const connect = controller.connect();
    await vi.waitFor(() => expect(runtime.initialize).toHaveBeenCalledOnce());
    const disconnect = controller.disconnect();
    initialize.resolve();

    await expect(connect).rejects.toThrow("superseded");
    await disconnect;
    expect(runtime.verifyIdentity).not.toHaveBeenCalled();
    expect(runtime.verifyReady).not.toHaveBeenCalled();
  });

  it("does not revive an older generation when logout races a credential refresh", async () => {
    const { runtime, api, controller } = harness();
    await controller.connect();
    await vi.waitFor(() => expect(runtime.verifyReady).toHaveBeenCalled());

    const replacing = deferred<void>();
    vi.mocked(runtime.replaceCredentials).mockReturnValueOnce(replacing.promise);
    vi.mocked(api.begin)
      .mockResolvedValueOnce({ expired: false, waitMs: null, credentialRefresh: session(2), operationId: null })
      .mockResolvedValueOnce({ expired: false, waitMs: null, credentialRefresh: null, operationId: "old-generation-write" });

    const write = controller.beginOperation("commit_edit", { objectType: "beat", objectIds: ["beat-1"] });
    await vi.waitFor(() => expect(runtime.replaceCredentials).toHaveBeenCalledOnce());
    const disconnect = controller.disconnect();
    replacing.resolve();

    await expect(write).rejects.toThrow();
    await disconnect;
    expect(api.authorize).not.toHaveBeenCalledWith(
      expect.anything(), "old-generation-write", expect.anything(), expect.anything(),
    );
    await expect(controller.connect()).rejects.toThrow("closed");
  });

  it("treats heartbeat expiry as integral local invalidation and denies subsequent reuse", async () => {
    vi.useFakeTimers();
    const { runtime, api, controller } = harness();
    vi.mocked(api.heartbeat).mockResolvedValueOnce({ expired: true, credentialRefresh: null });

    await controller.connect();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(api.heartbeat).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(runtime.shutdown).toHaveBeenCalled());

    // Expiry clears the old local generation. A later operation can only create
    // a brand-new session; it cannot authorize against the expired object.
    expect(api.authorize).not.toHaveBeenCalled();
    await controller.disconnect();
  });
});
