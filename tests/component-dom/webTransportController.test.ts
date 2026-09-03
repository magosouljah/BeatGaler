import { describe, expect, it, vi } from "vitest";
import {
  WebTransportController,
  type WebTransportControlApi,
  type WebTransportRuntime,
} from "../../src/features/cloud/webTransportController";
import type {
  WebTransportCapabilityScope,
  WebTransportSession,
} from "../../src/features/cloud/webTransportSession";

const uploadScope: WebTransportCapabilityScope = {
  objectType: "beat",
  objectIds: ["beat-1"],
};

function session(version = 1): WebTransportSession {
  return {
    mode: "galer-direct-temp-mtproto",
    session_id: "web-session",
    transport_id: "transport-1",
    transport_user_id: null,
    transport_username: null,
    chat_id: "vault-1",
    resolver_chat_id: null,
    generation: 7,
    credential_version: version,
    heartbeat_interval_ms: 60_000,
    heartbeat_timeout_ms: 300_000,
    token_rotation_enabled: false,
    temp_auth_required: false,
    temp_auth: {
      version: 1,
      dc_id: 2,
      expected_bot_id: "transport-1",
      expires_at: 2_000_000_000,
      binding: {
        perm_auth_key_id: { low: version, high: 0, unsigned: true },
        encrypted_message: `binding-${version}`,
      },
    },
    temp_auth_key: new Uint8Array([version, 7, 1]),
    temp_primary_dcs: { dc: 2 },
  };
}

function harness() {
  const runtime: WebTransportRuntime = {
    initialize: vi.fn(async () => {}),
    replaceCredentials: vi.fn(async () => {}),
    verifyReady: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
  };
  const api: WebTransportControlApi = {
    prepare: vi.fn(async () => session()),
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
  it("keeps callers joined while initialize is pending and never activates early", async () => {
    const { controller, runtime, api } = harness();
    let finishInitialize!: () => void;
    const waiting = new Promise<void>(resolve => { finishInitialize = resolve; });
    vi.mocked(runtime.initialize).mockReturnValueOnce(waiting);
    const first = controller.connect();
    const second = controller.connect();
    await vi.waitFor(() => expect(runtime.initialize).toHaveBeenCalledOnce());
    expect(api.prepare).toHaveBeenCalledOnce();
    expect(api.activate).not.toHaveBeenCalled();
    expect(runtime.verifyReady).not.toHaveBeenCalled();
    finishInitialize();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(api.activate).toHaveBeenCalledOnce();
    expect(runtime.verifyReady).toHaveBeenCalledOnce();
    expect(vi.mocked(api.activate).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(runtime.verifyReady).mock.invocationCallOrder[0]);
    await controller.disconnect();
  });

  it("singleflights concurrent session startup and activates only after the runtime listens", async () => {
    const { controller, runtime, api } = harness();
    const [first, second] = await Promise.all([controller.connect(), controller.connect()]);

    expect(first).toBe(second);
    expect(api.prepare).toHaveBeenCalledOnce();
    expect(runtime.initialize).toHaveBeenCalledWith(first);
    expect(api.activate).toHaveBeenCalledWith(first);
    expect(runtime.verifyReady).toHaveBeenCalledWith(first);

    await controller.disconnect();
  });

  it("installs temporary-auth refreshes before retrying and authorizing an operation", async () => {
    const { controller, runtime, api } = harness();
    vi.mocked(api.begin)
      .mockResolvedValueOnce({ expired: false, waitMs: null, credentialRefresh: session(2), operationId: null })
      .mockResolvedValueOnce({ expired: false, waitMs: null, credentialRefresh: null, operationId: "op-refreshed" });

    const lease = await controller.beginOperation("upload", uploadScope);

    expect(runtime.replaceCredentials).toHaveBeenCalledWith(expect.objectContaining({ credential_version: 2 }));
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
