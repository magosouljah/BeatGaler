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
    mode: "galer-direct-web-mtproto",
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
    bot_token: `secret-${version}`,
    telegram_api_id: 123,
    telegram_api_hash: `hash-${version}`,
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

  it("installs encrypted credential refreshes before retrying and authorizing an operation", async () => {
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
