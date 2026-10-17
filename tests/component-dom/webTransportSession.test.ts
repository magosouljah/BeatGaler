// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/platform/webClientId", () => ({
  getWebClientId: () => "beatgaler-web-browser-test",
}));

vi.mock("../../src/components/AccountGate", () => ({
  getBeatGalerAuthToken: () => "test-token",
  getResolvedCloudApiBase: () => "https://cloud.test",
  restoreBeatGalerSession: vi.fn(async () => ({ id: 'test-user' })),
}));

import { restoreBeatGalerSession } from "../../src/components/AccountGate";
import { authorizeWebTransportProject, cancelWebTransportBeat, uploadWebTransportProject, webTransportRequestBody } from "../../src/features/cloud/webTransportSession";

afterEach(() => {
  sessionStorage.clear();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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

  it('retries a PROJECT upload once when session restore rotates CSRF before Cloud admits the request', async () => {
    let cookieCsrf = 'csrf-old';
    vi.spyOn(document, 'cookie', 'get').mockImplementation(() => `__Host-beatgaler_csrf=${cookieCsrf}`);
    const attempts: Array<{ csrf: string; body: FormData }> = [];
    class FakeXhr {
      status = 0;
      responseText = '';
      upload = { onprogress: null as ((event: { loaded: number }) => void) | null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      ontimeout: (() => void) | null = null;
      withCredentials = false;
      timeout = 0;
      headers: Record<string, string> = {};
      open() {}
      setRequestHeader(name: string, value: string) { this.headers[name] = value; }
      send(body: FormData) {
        attempts.push({ csrf: this.headers['X-BeatGaler-CSRF'], body });
        if (attempts.length === 1) {
          cookieCsrf = 'csrf-new';
          this.status = 403;
          this.responseText = JSON.stringify({ code: 'CSRF_REQUIRED', error: 'CSRF validation failed.' });
        } else {
          this.status = 200;
          this.responseText = JSON.stringify({ telegram_message_id: 88, original_size: 3 });
        }
        this.onload?.();
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const file = new File([new Uint8Array([1, 2, 3])], 'project.zip');
    const result = await uploadWebTransportProject(
      { file, filename: file.name, beatId: 'beat-a', threadId: 42 },
      { operationId: 'cap_project', sessionId: 'session-1', generation: 2 }, 'commit_import',
    );
    expect(result.telegram_message_id).toBe(88);
    expect(attempts).toHaveLength(2);
    expect(attempts.map(attempt => attempt.csrf)).toEqual(['csrf-old', 'csrf-new']);
    expect(attempts[0].body).toBe(attempts[1].body);
    expect((attempts[0].body.get('file') as File).size).toBe(file.size);
  });

  it('uses the session token accepted by control requests when the visible cookie differs', async () => {
    vi.spyOn(document, 'cookie', 'get').mockImplementation(() => '__Host-beatgaler_csrf=csrf-cookie-old');
    sessionStorage.setItem('beatgaler:web-csrf:v1', 'csrf-session-current');
    const sent: string[] = [];
    class FakeXhr {
      status = 200;
      responseText = JSON.stringify({ telegram_message_id: 88, original_size: 3 });
      upload = { onprogress: null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      ontimeout: (() => void) | null = null;
      withCredentials = false;
      timeout = 0;
      open() {}
      setRequestHeader(name: string, value: string) { if (name === 'X-BeatGaler-CSRF') sent.push(value); }
      send() { this.onload?.(); }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const file = new File([new Uint8Array([1, 2, 3])], 'project.zip');
    await uploadWebTransportProject({ file, filename: file.name, beatId: 'beat-a', threadId: 42 },
      { operationId: 'cap_project', sessionId: 'session-1', generation: 2 }, 'commit_import');
    expect(sent).toEqual(['csrf-session-current']);
    expect(restoreBeatGalerSession).not.toHaveBeenCalled();
  });

  it('restores the session before one retry when an explicit CSRF denial keeps the same token', async () => {
    sessionStorage.setItem('beatgaler:web-csrf:v1', 'csrf-old');
    vi.mocked(restoreBeatGalerSession).mockImplementationOnce(async () => {
      sessionStorage.setItem('beatgaler:web-csrf:v1', 'csrf-new');
      return { id: 'test-user' } as Awaited<ReturnType<typeof restoreBeatGalerSession>>;
    });
    const sent: string[] = [];
    class FakeXhr {
      status = 0;
      responseText = '';
      upload = { onprogress: null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      ontimeout: (() => void) | null = null;
      withCredentials = false;
      timeout = 0;
      headers: Record<string, string> = {};
      open() {}
      setRequestHeader(name: string, value: string) { this.headers[name] = value; }
      send() {
        sent.push(this.headers['X-BeatGaler-CSRF']);
        this.status = sent.length === 1 ? 403 : 200;
        this.responseText = JSON.stringify(sent.length === 1
          ? { code: 'CSRF_REQUIRED', error: 'CSRF validation failed.' }
          : { telegram_message_id: 88, original_size: 3 });
        this.onload?.();
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const file = new File([new Uint8Array([1, 2, 3])], 'project.zip');
    await uploadWebTransportProject({ file, filename: file.name, beatId: 'beat-a', threadId: 42 },
      { operationId: 'cap_project', sessionId: 'session-1', generation: 2 }, 'commit_import');
    expect(sent).toEqual(['csrf-old', 'csrf-new']);
    expect(restoreBeatGalerSession).toHaveBeenCalledTimes(1);
  });

  it('does not replay a PROJECT upload for a non-CSRF access denial', async () => {
    let cookieCsrf = 'csrf-old';
    vi.spyOn(document, 'cookie', 'get').mockImplementation(() => `__Host-beatgaler_csrf=${cookieCsrf}`);
    let sends = 0;
    class FakeXhr {
      status = 403;
      responseText = JSON.stringify({ code: 'PROJECT_UPLOAD_DENIED', error: 'PROJECT unavailable.' });
      upload = { onprogress: null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      ontimeout: (() => void) | null = null;
      withCredentials = false;
      timeout = 0;
      open() {}
      setRequestHeader() {}
      send() { sends += 1; cookieCsrf = 'csrf-new'; this.onload?.(); }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const file = new File([new Uint8Array([1, 2, 3])], 'project.zip');
    await expect(uploadWebTransportProject(
      { file, filename: file.name, beatId: 'beat-a', threadId: 42 },
      { operationId: 'cap_project', sessionId: 'session-1', generation: 2 }, 'commit_import',
    )).rejects.toThrow('PROJECT unavailable.');
    expect(sends).toBe(1);
  });
});
