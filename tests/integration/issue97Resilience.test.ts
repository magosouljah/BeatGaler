// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Beat } from "../../src/types";
import { createBeatRuntimeState, transitionBeatRuntimeState } from "../../src/features/state/beatRuntimeState";

function makeBeat(id = "beat-97"): Beat {
  return {
    id,
    name: "Issue 97",
    folder_path: "",
    mp3_path: "master.mp3",
    wav_path: null,
    playback_path: "master.mp3",
    bpm: "140",
    key: "F#m",
    needs_resolution: false,
    tags: [],
    rating: 0,
    image_base64: "data:image/png;base64,AA==",
    image_preview_base64: "data:image/png;base64,AA==",
    image_crop: null,
    has_wav: false,
    has_stems: false,
    has_samples: false,
    samples_path: null,
    has_flp: false,
    has_als: false,
    stems_path: null,
    flp_path: null,
    als_path: null,
    other_files: [],
    color: "#111111",
    color2: "#222222",
    has_loop: false,
    loop_path: null,
    cloud_status: "SYNCED",
    telegram_file_id: "direct:97",
    telegram_message_id: 97,
    offline_available: false,
  };
}

async function loadLibraryManager(restore: ReturnType<typeof vi.fn>, load: ReturnType<typeof vi.fn>) {
  vi.resetModules();
  vi.doMock("../../src/platform", () => ({
    platform: {
      kind: "web",
      library: {
        restoreAuthoritative: restore,
        load,
        commitSnapshot: vi.fn(),
      },
    },
  }));
  return import("../../src/lib/libraryStateManager");
}

describe("Issue #97 reload/temp-auth resilience", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("keeps the last verified library visible when a later authority reload fails", async () => {
    const beat = makeBeat();
    const restore = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Step 4: invalid nonce hash from server"));
    const load = vi.fn(async () => [beat]);
    const { libraryStateManager } = await loadLibraryManager(restore, load);

    expect((await libraryStateManager.reloadAuthoritative()).map(item => item.id)).toEqual([beat.id]);
    expect((await libraryStateManager.reloadAuthoritative()).map(item => item.id)).toEqual([beat.id]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("treats duplicate SYNC_QUEUE_UPDATE while pending_update as idempotent", () => {
    const beat = makeBeat();
    const synced = createBeatRuntimeState(beat);
    const pending = transitionBeatRuntimeState(synced, { type: "SYNC_QUEUE_UPDATE" });
    const duplicate = transitionBeatRuntimeState(pending, { type: "SYNC_QUEUE_UPDATE" });

    expect(pending.sync_state).toBe("pending_update");
    expect(duplicate).toBe(pending);
  });

  it("retries invalid nonce with a fresh temp-auth object while preserving the lease identity", async () => {
    vi.resetModules();
    vi.doMock("../../src/components/AccountGate", () => ({
      getBeatGalerAuthToken: () => "session-token",
      getResolvedCloudApiBase: () => "/beatgaler-api",
    }));
    vi.doMock("../../src/platform/webClientId", () => ({ getWebClientId: () => "browser-97" }));

    const prepared = {
      dcId: 2,
      metadata: {
        msgId: { low: 1, high: 0, unsigned: false },
        nonce: { low: 2, high: 0, unsigned: false },
        tempAuthKeyId: { low: 3, high: 0, unsigned: false },
        tempSessionId: { low: 4, high: 0, unsigned: false },
        expiresAt: 123456,
      },
      bind: vi.fn(async () => ({
        authKey: new Uint8Array([1, 2, 3]),
        primaryDcs: { main: { id: 2 } },
        sessionState: {
          seqNo: 0,
          lastMessageId: { low: 0, high: 0, unsigned: false },
          timeOffset: 0,
          serverSalt: { low: 0, high: 0, unsigned: false },
          queuedAcks: [],
          bindMsgId: { low: 1, high: 0, unsigned: false },
          lastSessionCreatedUid: { low: 0, high: 0, unsigned: false },
        },
      })),
      destroy: vi.fn(async () => undefined),
    };
    const prepareWebTempAuth = vi.fn()
      .mockRejectedValueOnce(new Error("Step 4: invalid nonce hash from server"))
      .mockResolvedValueOnce(prepared);
    vi.doMock("../../src/features/cloud/webTempAuth", () => ({ prepareWebTempAuth }));

    const lease = {
      mode: "galer-direct-temp-mtproto",
      session_id: "lease-97",
      transport_id: "bot-slot-7",
      transport_user_id: "777",
      transport_username: "GalerBot",
      chat_id: "-10097",
      resolver_chat_id: null,
      generation: 4,
      credential_version: 1,
      heartbeat_interval_ms: 60000,
      heartbeat_timeout_ms: 300000,
      token_rotation_enabled: false,
      temp_auth_required: true,
      temp_auth: {
        version: 1,
        dc_id: 2,
        api_id: 12345,
        expected_bot_id: "777",
        expires_at: null,
        binding: null,
      },
    };
    const boundLease = {
      ...lease,
      temp_auth: {
        ...lease.temp_auth,
        expires_at: prepared.metadata.expiresAt,
        binding: {
          perm_auth_key_id: { low: 9, high: 0, unsigned: false },
          encrypted_message: "AA==",
        },
      },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => lease })
      .mockResolvedValueOnce({ ok: true, json: async () => boundLease });
    vi.stubGlobal("fetch", fetchMock);

    const { prepareWebTransportSession, isTransientWebTempAuthError } = await import("../../src/features/cloud/webTransportSession");
    expect(isTransientWebTempAuthError(new Error("Step 4: invalid nonce hash from server"))).toBe(true);

    const session = await prepareWebTransportSession();
    expect(prepareWebTempAuth).toHaveBeenCalledTimes(2);
    expect(session.session_id).toBe(lease.session_id);
    expect(session.generation).toBe(lease.generation);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(prepared.bind).toHaveBeenCalledTimes(1);
    expect(prepared.destroy).toHaveBeenCalledTimes(1);
  });
});
