// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";

vi.mock("../../src/platform/webClientId", () => ({
  getWebClientId: () => "beatgaler-web-browser-test",
}));

vi.mock("../../src/components/AccountGate", () => ({
  getBeatGalerAuthToken: () => "test-token",
  getResolvedCloudApiBase: () => "https://cloud.test",
}));

import { authorizeWebTransportProject, cancelWebTransportBeat, uploadWebTransportProject, webTransportRequestBody } from "../../src/features/cloud/webTransportSession";

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

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

  it("sends PROJECT bytes only to signed staging parts and waits for the MASTER receipt", async () => {
    vi.stubGlobal('crypto', webcrypto);
    const bytes = Uint8Array.from([1, 2, 3]);
    const file = { size: 3, slice: (start: number, end: number) => ({
      size: end - start,
      arrayBuffer: async () => bytes.slice(start, end).buffer,
    }) } as unknown as File;
    const receipt = { telegram_file_id: 'direct:88', telegram_message_id: 88,
      original_size: 3, filename: 'project.zip', parts: [], transport: 'direct-web' };
    const requests: { path: string; body: Record<string, unknown> }[] = [];
    let stagedBytes = 0;
    let resumeParts: { number: number; size: number; checksum: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (inputUrl: string | URL, options: RequestInit) => {
      const url = String(inputUrl);
      if (url.startsWith('https://staging.s3.')) {
        stagedBytes += Number((options.body as { size?: number })?.size || 0);
        expect(options.headers).toMatchObject({ 'x-amz-checksum-sha256': expect.any(String) });
        return { ok: true };
      }
      const path = url.replace('https://cloud.test', '');
      const body = JSON.parse(String(options.body));
      requests.push({ path, body });
      const response = path.endsWith('/start') ? { id: 'upload-id', state: 'UPLOADING', partBytes: 16 * 1024 * 1024 }
        : path.endsWith('/status') ? { id: 'upload-id', state: 'UPLOADING', parts: resumeParts }
        : path.endsWith('/part-url') ? { url: 'https://staging.s3.us-east-1.amazonaws.com/part',
          headers: { 'x-amz-checksum-sha256': body.sha256Base64 } }
        : { id: 'upload-id', state: 'COMPLETED', upload: receipt };
      return { ok: true, json: async () => response };
    }));
    const progress: number[] = [];
    const result = await uploadWebTransportProject({ file, filename: 'project.zip', beatId: 'beat-a', threadId: 42 },
      { operationId: 'cap_project', sessionId: 'session-1', generation: 2 }, 'commit_import',
      state => progress.push(state.uploadedBytes));
    expect(result.telegram_message_id).toBe(88);
    expect(stagedBytes).toBe(3);
    expect(requests.map(request => request.path)).toEqual([
      '/transport/project/multipart/start', '/transport/project/multipart/status',
      '/transport/project/multipart/part-url', '/transport/project/multipart/complete',
    ]);
    expect(requests[0].body).toMatchObject({ beatId: 'beat-a', sizeBytes: 3,
      operationId: 'cap_project', kind: 'commit_import',
      scope: { objectType: 'beat', objectIds: ['beat-a'] } });
    expect(progress).toEqual([0, 3, 3]);
    resumeParts = [{ number: 1, size: 3,
      checksum: String(requests.find(request => request.path.endsWith('/part-url'))?.body.sha256Base64) }];
    const resumed = await uploadWebTransportProject({ file, filename: 'project.zip', beatId: 'beat-a', threadId: 42 },
      { operationId: 'cap_project', sessionId: 'session-1', generation: 2 }, 'commit_import');
    expect(resumed.telegram_message_id).toBe(88);
    expect(stagedBytes).toBe(3);
    expect(requests.filter(request => request.path.endsWith('/part-url'))).toHaveLength(1);
  });
});
