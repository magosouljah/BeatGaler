// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/webClientId", () => ({ getWebClientId: () => "browser-bound" }));
vi.mock("../../src/features/auth/webSession", () => ({
  getBeatGalerAuthToken: () => "session-token",
  getResolvedCloudApiBase: () => "/beatgaler-api",
  restoreBeatGalerSession: vi.fn(async () => ({ id: "account-bound" })),
}));

const prepareWebTempAuth = vi.hoisted(() => vi.fn());
vi.mock("../../src/features/cloud/webTempAuth", () => ({ prepareWebTempAuth }));

import { bindWebTransportSession, renewWebTransportSession, type WebTransportSessionPublic } from "../../src/features/cloud/webTransportSession";

const long = (low: number) => ({ low, high: low + 1, unsigned: false });
const sessionState = {
  seqNo: 6,
  lastMessageId: long(10),
  timeOffset: 3,
  serverSalt: long(20),
  queuedAcks: [long(30)],
  bindMsgId: long(40),
  lastSessionCreatedUid: long(50),
};

function lease(overrides: Record<string, unknown> = {}) {
  return {
    mode: "galer-direct-temp-mtproto",
    session_id: "lease-1",
    transport_id: "bot-1",
    transport_user_id: "777",
    chat_id: "-10097",
    generation: 4,
    credential_version: 1,
    temp_auth_required: true,
    temp_auth: { version: 1, dc_id: 2, api_id: 12345, expected_bot_id: "777", expires_at: null, binding: null },
    ...overrides,
  } as unknown as WebTransportSessionPublic;
}

function prepared(expiresAt = 5000) {
  return {
    dcId: 2,
    metadata: { msgId: long(1), nonce: long(2), tempAuthKeyId: long(3), tempSessionId: long(4), expiresAt },
    bind: vi.fn(async () => ({ authKey: new Uint8Array([1, 2, 3]), primaryDcs: { main: { id: 2 } }, sessionState })),
    destroy: vi.fn(async () => undefined),
  };
}

function answerWith(body: unknown) {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => body }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function bound(base: WebTransportSessionPublic, expiresAt: number) {
  return {
    ...base,
    temp_auth: { ...base.temp_auth, expires_at: expiresAt, binding: { perm_auth_key_id: long(9), encrypted_message: "AA==" } },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  prepareWebTempAuth.mockReset();
});

describe("Web transport bound temporary session (M10: comportamiento)", () => {
  it("keeps the exact temp session id that was bound and the protocol state returned by the bind", async () => {
    const temp = prepared();
    prepareWebTempAuth.mockResolvedValue(temp);
    const base = lease();
    const fetchMock = answerWith(bound(base, 5000));

    const session = await bindWebTransportSession(base);

    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toMatchObject({
      browserClientId: "browser-bound",
      tempAuthMetadata: { tempSessionId: long(4), msgId: long(1), expiresAt: 5000 },
    });
    expect(temp.bind).toHaveBeenCalledExactlyOnceWith({ perm_auth_key_id: long(9), encrypted_message: "AA==" });
    expect(session.temp_session_id).toEqual(long(4));
    expect(session.temp_session_state).toEqual(sessionState);
    expect(session.temp_auth_key).toEqual(new Uint8Array([1, 2, 3]));
    expect(session.temp_primary_dcs).toEqual({ main: { id: 2 } });
    expect(session.temp_auth_required).toBe(false);
    expect(temp.destroy).toHaveBeenCalledOnce();
  });

  it("renews with the id and state of the new binding, not the previous session", async () => {
    const temp = prepared(7000);
    prepareWebTempAuth.mockResolvedValue(temp);
    const base = lease();
    answerWith(bound(base, 7000));
    const previous = { ...base, temp_session_id: long(99), temp_session_state: { ...sessionState, seqNo: 1 } } as never;

    const renewed = await renewWebTransportSession(previous);

    expect(renewed.temp_session_id).toEqual(long(4));
    expect(renewed.temp_session_state).toEqual(sessionState);
  });

  it("refuses a lease response that carries permanent credentials and discards the temporary auth", async () => {
    const temp = prepared();
    prepareWebTempAuth.mockResolvedValue(temp);
    const base = lease();
    answerWith({ ...bound(base, 5000), temp_auth: { ...bound(base, 5000).temp_auth, api_hash: "x" }, telegram_api_hash: "leak" });

    await expect(bindWebTransportSession(base)).rejects.toThrow("unsafe transport credential");
    expect(temp.bind).not.toHaveBeenCalled();
    expect(temp.destroy).toHaveBeenCalledOnce();
  });
});
