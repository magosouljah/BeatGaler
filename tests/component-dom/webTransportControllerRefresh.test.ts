import { describe, expect, it, vi } from "vitest";
import {
  WebTransportController,
  type WebTransportControlApi,
  type WebTransportRuntime,
} from "../../src/features/cloud/webTransportController";
import type {
  WebTransportSession,
  WebTransportSessionPublic,
} from "../../src/features/cloud/webTransportSession";

function bootstrap(generation: number, credentialVersion: number): WebTransportSessionPublic {
  return {
    mode: "galer-direct-temp-mtproto",
    session_id: "session-1",
    transport_id: "transport-1",
    transport_user_id: "100",
    transport_username: "bot",
    chat_id: "-100123",
    resolver_chat_id: "-100123",
    generation,
    credential_version: credentialVersion,
    heartbeat_interval_ms: 60_000,
    heartbeat_timeout_ms: 300_000,
    token_rotation_enabled: true,
    temp_auth_required: true,
    temp_auth: {
      version: 1,
      dc_id: 2,
      api_id: 12345,
      expected_bot_id: "100",
      expires_at: Date.now() + 300_000,
      binding: null,
    },
  };
}

function boundSession(generation: number, credentialVersion: number): WebTransportSession {
  return {
    ...bootstrap(generation, credentialVersion),
    temp_auth_required: false,
    temp_auth: {
      ...bootstrap(generation, credentialVersion).temp_auth,
      expires_at: Date.now() + 300_000,
      binding: {} as WebTransportSession["temp_auth"]["binding"],
    },
    temp_auth_key: new Uint8Array(256),
    temp_session_id: { low: 1, high: 2, unsigned: false },
    temp_session_state: {
      seqNo: 0,
      lastMessageId: { low: 0, high: 0, unsigned: false },
      timeOffset: 0,
      serverSalt: { low: 0, high: 0, unsigned: false },
      queuedAcks: [],
      bindMsgId: { low: 0, high: 0, unsigned: false },
      lastSessionCreatedUid: { low: 0, high: 0, unsigned: false },
    },
    temp_primary_dcs: {},
  } as WebTransportSession;
}

describe("WebTransportController credential refresh", () => {
  it("re-verifies refreshed Worker credentials before authorizing the next operation", async () => {
    const initial = boundSession(1, 1);
    const refreshed = boundSession(1, 2);
    const events: string[] = [];
    const runtime: WebTransportRuntime = {
      initialize: vi.fn(async session => { events.push(`initialize:${session.credential_version}`); }),
      replaceCredentials: vi.fn(async session => { events.push(`replace:${session.credential_version}`); }),
      verifyIdentity: vi.fn(async session => { events.push(`identity:${session.credential_version}`); }),
      verifyReady: vi.fn(async session => { events.push(`verify:${session.credential_version}`); }),
      shutdown: vi.fn(async () => { events.push("shutdown"); }),
    };
    let beginCalls = 0;
    const api: WebTransportControlApi = {
      reserve: vi.fn(async () => bootstrap(1, 1)),
      bind: vi.fn(async () => initial),
      activate: vi.fn(async () => {}),
      heartbeat: vi.fn(async () => ({ expired: false, credentialRefresh: null })),
      authorize: vi.fn(async () => { events.push("authorize"); }),
      begin: vi.fn(async () => {
        beginCalls += 1;
        if (beginCalls === 1) {
          return {
            expired: false,
            waitMs: null,
            credentialRefresh: refreshed,
            operationId: null,
          };
        }
        return {
          expired: false,
          waitMs: null,
          credentialRefresh: null,
          operationId: "operation-1",
        };
      }),
      end: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };

    const controller = new WebTransportController(runtime, api);
    const lease = await controller.beginOperation("stream_master", {
      objectType: "message",
      objectIds: ["123"],
    });

    expect(lease.operationId).toBe("operation-1");
    expect(events).toContain("replace:2");
    expect(events).toContain("identity:2");
    expect(events).toContain("verify:2");
    expect(events.indexOf("replace:2")).toBeLessThan(events.indexOf("identity:2"));
    expect(events.indexOf("replace:2")).toBeLessThan(events.indexOf("verify:2"));
    expect(events.indexOf("identity:2")).toBeLessThan(events.indexOf("authorize"));
    expect(events.indexOf("verify:2")).toBeLessThan(events.indexOf("authorize"));
    expect(runtime.replaceCredentials).toHaveBeenCalledTimes(1);
    expect(runtime.verifyIdentity).toHaveBeenCalledTimes(2);
    expect(runtime.verifyReady).toHaveBeenCalledTimes(2);

    await controller.endOperation(lease);
    await controller.disconnect();
  });
});
