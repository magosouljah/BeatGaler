// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/platform/webClientId", () => ({
  getWebClientId: () => "beatgaler-web-browser-test",
}));

vi.mock("../../src/components/AccountGate", () => ({
  getBeatGalerAuthToken: () => "test-token",
  getResolvedCloudApiBase: () => "https://cloud.test",
}));

import { authorizeWebTransportProject, cancelWebTransportBeat, uploadWebTransportProject, webTransportRequestBody } from "../../src/features/cloud/webTransportSession";

afterEach(() => vi.unstubAllGlobals());

describe("Web transport control-plane identity", () => {
  it("attaches the authorized browser installation id to every request body", () => {
    expect(webTransportRequestBody({ sessionId: "session-1", generation: 2 })).toEqual({
      sessionId: "session-1",
      generation: 2,
      beatgalerUserId: "beatgaler-web-browser-test",
    });
  });

  it("does not allow a caller to override the browser installation id", () => {
    expect(webTransportRequestBody({ beatgalerUserId: "foreign-installation" })).toEqual({
      beatgalerUserId: "beatgaler-web-browser-test",
    });
  });

  it("sends PROJECT preflight with the exact beat operation capability", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, maxBytes: 1_000_000_000 }) }));
    vi.stubGlobal("fetch", fetchMock);
    const lease = { operationId: "cap_project", sessionId: "session-1", generation: 2 };
    await authorizeWebTransportProject("beat-a", 123, lease, "commit_import");
    const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://cloud.test/transport/project/authorize");
    expect(JSON.parse(String(options.body))).toMatchObject({
      beatgalerUserId: "beatgaler-web-browser-test", beatId: "beat-a", declaredBytes: 123,
      operationId: "cap_project", kind: "commit_import",
      scope: { objectType: "beat", objectIds: ["beat-a"] },
    });
    await cancelWebTransportBeat("beat-a", lease);
    expect(fetchMock.mock.calls[1][0]).toBe("https://cloud.test/transport/quota/cancel");
  });

  it("surfaces a server Access denial before the upload proceeds", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 403,
      json: async () => ({ code: "PROJECT_UPLOAD_DENIED", error: "PROJECT upload is not available on this plan." }) })));
    await expect(authorizeWebTransportProject("beat-a", 123,
      { operationId: "cap_project", sessionId: "session-1", generation: 2 }, "commit_edit"))
      .rejects.toThrow("PROJECT upload is not available on this plan.");
  });

  it("uploads PROJECT through the server with its exact capability and measured response", async () => {
    let captured: { url: string; headers: Record<string, string>; body: FormData } | null = null;
    class FakeXhr {
      status = 200;
      responseText = JSON.stringify({ telegram_file_id: 'direct:88', telegram_message_id: 88,
        original_size: 3, filename: 'project.zip', parts: [], transport: 'direct-web' });
      upload: { onprogress: ((event: { loaded: number }) => void) | null } = { onprogress: null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      ontimeout: (() => void) | null = null;
      withCredentials = false;
      timeout = 0;
      headers: Record<string, string> = {};
      url = '';
      open(_method: string, url: string) { this.url = url; }
      setRequestHeader(name: string, value: string) { this.headers[name] = value; }
      send(body: FormData) {
        captured = { url: this.url, headers: this.headers, body };
        this.upload.onprogress?.({ loaded: 2 });
        this.onload?.();
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const file = new File([new Uint8Array([1, 2, 3])], 'project.zip');
    const progress: number[] = [];
    const result = await uploadWebTransportProject({ file, filename: file.name, beatId: 'beat-a', threadId: 42 },
      { operationId: 'cap_project', sessionId: 'session-1', generation: 2 }, 'commit_import',
      state => progress.push(state.uploadedBytes));
    expect(result.telegram_message_id).toBe(88);
    expect(captured?.url).toBe('https://cloud.test/transport/project/upload');
    expect(captured?.headers['X-BeatGaler-Project-Operation']).toBe('cap_project');
    expect(captured?.headers['X-BeatGaler-Project-Kind']).toBe('commit_import');
    expect(captured?.body.get('file')).toBeInstanceOf(File);
    expect(progress).toEqual([2, 3]);
  });
});
