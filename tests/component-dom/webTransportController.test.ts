import { describe, expect, it, vi } from "vitest";
import {
  WebTransportController,
  type WebTransportControlApi,
  type WebTransportRuntime,
} from "../../src/features/cloud/webTransportController";
import type {
  WebTransportCapabilityScope,
  WebTransportSession,
  WebTransportSessionPublic,
} from "../../src/features/cloud/webTransportSession";

const uploadScope: WebTransportCapabilityScope = {
  objectType: "beat",
  objectIds: ["beat-1"],
};

function bootstrap(version = 1): WebTransportSessionPublic {
  return {
    mode: "galer-direct-temp-mtproto",
    session_id: "web-session",
    transport_id: "transport-1",
    transport_user_id: "101",
    transport_username: "transport_1_bot",
    chat_id: "-100123",
    resolver_chat_id: null,
    generation: 7,
    credential_version: version,
    heartbeat_interval_ms: 60_000,
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
      version: 1,
      dc_id: 2,
      api_id: 12345,
      expected_bot_id: "101",
      expires_at: 2_000_000_000,
      binding: {
        perm_auth_key_id: { low: version, high: 0, unsigned: true },
        encrypted_message: `binding-${version}`,
      },
    },
    temp_auth_key: new Uint8Array(256).fill(version),
    temp_session_id: { low: version, high: 0, unsigned: true },
    temp_session_state: {} as WebTransportSession["temp_session_state"],
    temp_primary_dcs: { main: { id: 2 } },
  };
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

describe("Galer Cloud Web transport lifecycle", () => {
  it("overlaps activation with temp-auth binding and starts background verification after Worker media initialization", async () => {
    const { controller, runtime, api } = harness();
    let finishBind!: () => void;
    let finishActivate!: () => void;
    const bindWaiting = new Promise<void>(resolve => { finishBind = resolve; });
    const activateWaiting = new Promise<void>(resolve => { finishActivate = resolve; });
    vi.mocked(api.bind).mockImplementationOnce(async () => {
      await bindWaiting;
      return session();
    });
    vi.mocked(api.activate).mockReturnValueOnce(activateWaiting);

    const first = controller.connect();
    const second = controller.connect();

    await vi.waitFor(() => expect(api.bind).toHaveBeenCalledOnce());
    expect(api.reserve).toHaveBeenCalledOnce();
    expect(api.activate).toHaveBeenCalledOnce();
    expect(runtime.initialize).not.toHaveBeenCalled();
    expect(runtime.verifyIdentity).not.toHaveBeenCalled();
    expect(runtime.verifyReady).not.toHaveBeenCalled();
    expect(vi.mocked(api.reserve).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.activate).mock.invocationCallOrder[0]);
    expect(vi.mocked(api.activate).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.bind).mock.invocationCallOrder[0]);

    finishBind();
    await Promise.resolve();
    expect(runtime.initialize).not.toHaveBeenCalled();
    expect(runtime.verifyIdentity).not.toHaveBeenCalled();
    expect(runtime.verifyReady).not.toHaveBeenCalled();

    finishActivate();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(runtime.initialize).toHaveBeenCalledOnce();
    expect(runtime.verifyIdentity).toHaveBeenCalledOnce();
    expect(runtime.verifyReady).toHaveBeenCalledOnce();
    expect(vi.mocked(api.activate).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(runtime.initialize).mock.invocationCallOrder[0]);
    expect(vi.mocked(runtime.initialize).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(runtime.verifyIdentity).mock.invocationCallOrder[0]);
    expect(vi.mocked(runtime.initialize).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(runtime.verifyReady).mock.invocationCallOrder[0]);
    await controller.disconnect();
  });

  it("singleflights concurrent session startup and begins background verification once", async () => {
    const { controller, runtime, api } = harness();
    const [first, second] = await Promise.all([controller.connect(), controller.connect()]);

    expect(first).toBe(second);
    expect(api.reserve).toHaveBeenCalledOnce();
    expect(api.bind).toHaveBeenCalledOnce();
    expect(runtime.initialize).toHaveBeenCalledWith(first, []);
    expect(api.activate).toHaveBeenCalledWith(expect.objectContaining({ session_id: "web-session", generation: 7 }));
    expect(runtime.verifyIdentity).toHaveBeenCalledWith(first);
    expect(runtime.verifyReady).toHaveBeenCalledWith(first);

    await controller.disconnect();
  });

  it("waits for in-flight activation before stopping when temp auth binding fails", async () => {
    const { controller, runtime, api } = harness();
    let finishActivate!: () => void;
    const activationFinished = vi.fn();
    const activateWaiting = new Promise<void>(resolve => {
      finishActivate = () => {
        activationFinished();
        resolve();
      };
    });
    vi.mocked(api.activate).mockReturnValueOnce(activateWaiting);
    vi.mocked(api.bind).mockRejectedValueOnce(new Error("temp auth failed"));

    const failure = controller.connect().catch(error => error as Error);
    await vi.waitFor(() => expect(api.activate).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(api.bind).toHaveBeenCalledOnce());
    expect(api.stop).not.toHaveBeenCalled();
    expect(runtime.shutdown).not.toHaveBeenCalled();

    finishActivate();
    expect((await failure).message).toBe("temp auth failed");
    expect(runtime.initialize).not.toHaveBeenCalled();
    expect(runtime.verifyIdentity).not.toHaveBeenCalled();
    expect(runtime.verifyReady).not.toHaveBeenCalled();
    expect(runtime.shutdown).toHaveBeenCalledOnce();
    expect(api.stop).toHaveBeenCalledWith(expect.objectContaining({ session_id: "web-session", generation: 7 }));
    expect(activationFinished.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.stop).mock.invocationCallOrder[0]);
  });

  it("waits for vault activation before running Worker initialization and then cleans up an initialization failure", async () => {
    const { controller, runtime, api } = harness();
    let finishActivate!: () => void;
    const activationFinished = vi.fn();
    vi.mocked(api.activate).mockReturnValueOnce(new Promise<void>(resolve => {
      finishActivate = () => {
        activationFinished();
        resolve();
      };
    }));
    vi.mocked(runtime.initialize).mockRejectedValueOnce(new Error("worker init failed"));

    const failure = controller.connect().catch(error => error as Error);
    await vi.waitFor(() => expect(api.activate).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(api.bind).toHaveBeenCalledOnce());
    expect(runtime.initialize).not.toHaveBeenCalled();
    expect(api.stop).not.toHaveBeenCalled();

    finishActivate();
    expect((await failure).message).toBe("worker init failed");
    expect(runtime.initialize).toHaveBeenCalledOnce();
    expect(runtime.verifyIdentity).not.toHaveBeenCalled();
    expect(runtime.verifyReady).not.toHaveBeenCalled();
    expect(runtime.shutdown).toHaveBeenCalledOnce();
    expect(api.stop).toHaveBeenCalledOnce();
    expect(activationFinished.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(runtime.initialize).mock.invocationCallOrder[0]);
    expect(activationFinished.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.stop).mock.invocationCallOrder[0]);
  });

  it("does not initialize Telegram media when activation fails while temp auth binding is still in flight", async () => {
    const { controller, runtime, api } = harness();
    let finishBind!: () => void;
    vi.mocked(api.bind).mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { finishBind = resolve; });
      return session();
    });
    vi.mocked(api.activate).mockRejectedValueOnce(new Error("activation failed"));

    const failure = controller.connect().catch(error => error as Error);
    await vi.waitFor(() => expect(api.activate).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(api.bind).toHaveBeenCalledOnce());
    expect(api.stop).not.toHaveBeenCalled();
    finishBind();

    expect((await failure).message).toBe("activation failed");
    expect(runtime.initialize).not.toHaveBeenCalled();
    expect(runtime.verifyIdentity).not.toHaveBeenCalled();
    expect(runtime.verifyReady).not.toHaveBeenCalled();
    expect(runtime.shutdown).toHaveBeenCalledOnce();
    expect(api.stop).toHaveBeenCalledOnce();
  });

  it("installs temporary-auth refreshes before retrying and authorizing an operation", async () => {
    const { controller, runtime, api } = harness();
    vi.mocked(api.begin)
      .mockResolvedValueOnce({ expired: false, waitMs: null, credentialRefresh: session(2), operationId: null })
      .mockResolvedValueOnce({ expired: false, waitMs: null, credentialRefresh: null, operationId: "op-refreshed" });

    const lease = await controller.beginOperation("upload", uploadScope);

    expect(runtime.replaceCredentials).toHaveBeenCalledWith(expect.objectContaining({ credential_version: 2 }));
    expect(runtime.verifyIdentity).toHaveBeenCalledWith(expect.objectContaining({ credential_version: 2 }));
    expect(api.authorize).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: "web-session", credential_version: 2 }),
      "op-refreshed",
      "upload",
      uploadScope,
    );
    expect(lease).toEqual({
      operationId: "op-refreshed",
      sessionId: "web-session",
      generation: 7,
      scope: uploadScope,
    });
    await controller.disconnect();
  });

  it("always releases a control-plane operation when data-plane work fails", async () => {
    const { controller, api } = harness();

    await expect(controller.withOperation("upload", uploadScope, async () => {
      throw new Error("upload failed");
    })).rejects.toThrow("upload failed");

    expect(api.authorize).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: "web-session" }),
      "op-1",
      "upload",
      uploadScope,
    );
    expect(api.end).toHaveBeenCalledWith(
      { session_id: "web-session", generation: 7 },
      "op-1",
    );
    await controller.disconnect();
    expect(api.stop).toHaveBeenCalledOnce();
  });

  it("does not execute data-plane work when scoped capability authorization fails", async () => {
    const { controller, api } = harness();
    const operation = vi.fn(async () => "should-not-run");
    vi.mocked(api.authorize).mockRejectedValueOnce(new Error("capability denied"));

    await expect(controller.withOperation("upload", uploadScope, operation)).rejects.toThrow("capability denied");

    expect(operation).not.toHaveBeenCalled();
    expect(api.end).toHaveBeenCalledWith(
      { session_id: "web-session", generation: 7 },
      "op-1",
    );
    await controller.disconnect();
  });
});
