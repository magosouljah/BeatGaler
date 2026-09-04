import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Beat } from "../../src/types";
import { commitWebBeatEdit } from "../../src/features/edit/webBeatEdit";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Issue #97 production runtime follow-up", () => {
  it("replaces a stale installation topic id with the vault-resolved topic after artwork upload", async () => {
    const original = {
      id: "beat-1",
      name: "Same Beat",
      bpm: "120",
      key: "Cm",
      tags: [],
      rating: 0,
      color: "#111111",
      color2: "#222222",
      telegram_file_id: "direct:101",
      telegram_message_id: 101,
      image_base64: null,
    } as unknown as Beat;
    const updated = { ...original, image_base64: "data:image/png;base64,YQ==" };
    const uploadedInputs: Array<Record<string, unknown>> = [];
    let publishedManifest: any = null;
    const runtime = {
      getLibraryIndex: vi.fn(async () => ({
        messageId: 500,
        manifest: {
          schema: "beatgaler.telegram.library",
          version: 2,
          beats: [{
            id: "beat-1",
            name: "Same Beat",
            bpm: "120",
            key: "Cm",
            tags: [],
            rating: 0,
            color: "#111111",
            color2: "#222222",
            telegram_topic_id: 4242,
            master: { telegram_message_id: 101, filename: "old.mp3", mime: "audio/mpeg", size: 10 },
          }],
          trash: [],
        },
      })),
      upload: vi.fn(async (input: Record<string, unknown>) => {
        uploadedInputs.push(input);
        return {
          telegram_file_id: "file-new",
          telegram_message_id: 202,
          filename: "cover.png",
          original_size: 1,
          parts: [],
          transport: "direct-web" as const,
          thread_id: 3131,
        };
      }),
      replaceLibraryIndex: vi.fn(async (input: { manifest: unknown }) => {
        publishedManifest = input.manifest;
        return { messageId: 501, beatCount: 1, updated: true };
      }),
    };

    await commitWebBeatEdit(original, updated, {}, runtime);
    expect(uploadedInputs).toHaveLength(1);
    expect(uploadedInputs[0]).not.toHaveProperty("threadId");
    expect(publishedManifest.beats[0].telegram_topic_id).toBe(3131);
  });

  it("keeps visible cloud cards playable while authority is still checking", () => {
    const app = source("src/App.tsx");
    const card = source("src/components/BeatCard.tsx");
    expect(app).toContain('playbackInteractive={connectionState !== "offline" || Boolean(beat.offline_available)}');
    expect(card).toContain("if (!playbackInteractive || playbackBlocked) {");
    expect(card).toContain("onPlay(beat);");
  });

  it("reveals a remembered local cache before auth restore and singleflights the duplicated gate restore", () => {
    const experienceGate = source("src/features/auth/AuthExperienceGate.tsx");
    const accountGate = source("src/components/AccountGate.tsx");

    expect(experienceGate).toContain("hasRememberedWebSessionMarker");
    expect(experienceGate).toContain("optimisticRememberedSession");
    expect(experienceGate).toContain('playTrace("AUTH_CACHE_REVEAL_OPTIMISTIC")');
    expect(experienceGate.indexOf("if (account || optimisticRememberedSession) return <>{children}</>;")).toBeLessThan(
      experienceGate.indexOf('if (checking) return <main className="bg-auth-shell"'),
    );
    expect(experienceGate).toContain("if (!value) setOptimisticRememberedSession(false);");

    expect(accountGate).toContain("hasRememberedWebSessionMarker");
    expect(accountGate).toContain("let restoreBeatGalerSessionInFlight: Promise<BeatGalerAccount | null> | null = null;");
    expect(accountGate).toContain("if (restoreBeatGalerSessionInFlight) return restoreBeatGalerSessionInFlight;");
    expect(accountGate).toContain("restoreBeatGalerSessionInFlight = pending;");
    expect(accountGate).toContain("pending.then(clear, clear);");
    expect(accountGate.indexOf("if (account || optimisticRememberedSession) return <>{children}</>")).toBeLessThan(
      accountGate.indexOf('if (checking) return <div className="bg-account-loading"'),
    );
    expect(accountGate).toContain("setOptimisticRememberedSession(false);");
  });

  it("returns the first MSE URL before Direct stream admission and starts remembered Direct through the definitive coordinator", () => {
    const playback = source("src/features/playback/webPlaybackSource.ts");
    const main = source("src/main.tsx");
    const adapter = source("src/platform/webAdapter.ts");
    const accountGate = source("src/components/AccountGate.tsx");
    const transport = source("src/features/cloud/webGalerCloudTransport.ts");
    const workerClient = source("src/features/cloud/webTransportWorkerClient.ts");
    const controller = source("src/features/cloud/webTransportController.ts");
    const sessionControl = source("src/features/cloud/webTransportSession.ts");
    const sessionBootstrap = source("src/features/auth/webSessionBootstrap.ts");

    expect(playback).toContain('playTrace("SOURCE_URL_READY", { beat_id: beatId, mode: "mse" });');
    expect(playback).toContain("void (async () => {");
    expect(playback).toContain("return Promise.resolve({ url, completed });");
    expect(playback).not.toContain("private async prepareMediaSource");

    expect(main).toContain("function preloadRememberedWebDirectCode(): void");
    expect(main).toContain("hasRememberedWebSessionMarker()");
    expect(main).toContain('playTrace("DIRECT_CODE_PRELOAD_BEGIN")');
    expect(main).toContain('void import("./features/playback/webStartupPlaybackCoordinator").then(');
    expect(main).toContain("function preconnectRememberedWebDirect(): void");
    expect(main).toContain("if (!readWebCsrfToken()) {");
    expect(main).toContain('playTrace("DIRECT_REMEMBERED_PRECONNECT_BEGIN")');
    expect(main).toContain("getWebStartupPlaybackCoordinator().start()");
    expect(main).toContain("preloadRememberedWebDirectCode();\npreconnectRememberedWebDirect();");
    expect(main.indexOf("preconnectRememberedWebDirect();")).toBeLessThan(main.indexOf("ReactDOM.createRoot"));
    expect(main).not.toContain("platform.cloudAuth.syncSession(null, \"\")");
    expect(main).not.toContain("new WebGalerCloudTransport");

    expect(sessionBootstrap).toContain('WEB_CSRF_COOKIE_NAME = "__Host-beatgaler_csrf"');
    expect(sessionBootstrap).toContain("window.sessionStorage.getItem(WEB_CSRF_SESSION_KEY)");
    expect(sessionBootstrap).toContain("readWebCookieValue(document.cookie, WEB_CSRF_COOKIE_NAME)");

    expect(adapter).toContain("function prewarmAuthenticatedWebTransport(): void");
    expect(adapter).toContain("async syncSession() {");
    expect(adapter).toContain("prewarmAuthenticatedWebTransport();");
    expect(adapter).toContain("resolveWebCoordinator().then(coordinator => coordinator.start())");
    expect(adapter).not.toContain("scheduleWebTransportPrewarm");
    expect(accountGate).toContain("await platform.cloudAuth.syncSession(null, getResolvedCloudApiBase());");

    expect(workerClient).toContain("prewarm(): void {");
    expect(workerClient).toContain('playTrace("WORKER_PREWARM_BEGIN")');
    expect(workerClient).toContain("this.ensureWorker();");
    expect(transport).toContain('playTrace("TRANSPORT_CODE_PREWARM_ENTER")');
    expect(transport).toContain("this.worker.prewarm();");
    expect(transport).toContain("async connectPlaybackDataPlane(): Promise<void>");

    expect(sessionControl).toContain("const csrf = readWebCsrfToken();");
    expect(sessionControl).toContain('if (csrf) headers["X-BeatGaler-CSRF"] = csrf;');
    expect(sessionControl).toContain('credentials: "include"');
    expect(sessionControl).toContain("export async function reserveWebTransportSession(startupBeatIds: readonly string[] = [])");
    expect(sessionControl).toContain("export async function bindWebTransportSession(bootstrap: WebTransportSessionPublic)");
    expect(sessionControl).toContain("return bindWebTransportSession(await reserveWebTransportSession(startupBeatIds));");

    const reserveIndex = controller.indexOf("bootstrap = await this.api.reserve(this.startupBeatIds);");
    const activateIndex = controller.indexOf('observePlayStep("DIRECT_ACTIVATE"');
    const bindIndex = controller.indexOf("this.api.bind(bootstrap!)");
    const activationGateIndex = controller.indexOf("const activationResult = await activationResultPromise;");
    const mediaGateIndex = controller.indexOf('playTrace("CONTROLLER_SESSION_MEDIA_GATE_OPEN")');
    const initializeIndex = controller.indexOf('observePlayStep("DIRECT_INITIALIZE"');
    const publishIndex = controller.indexOf("this.session = session;", initializeIndex);
    const backgroundIndex = controller.indexOf("this.startBackgroundVerification(session);", publishIndex);
    const readyIndex = controller.indexOf('playTrace("CONTROLLER_SESSION_DATA_PLANE_READY"', backgroundIndex);
    expect(reserveIndex).toBeGreaterThanOrEqual(0);
    expect(reserveIndex).toBeLessThan(activateIndex);
    expect(activateIndex).toBeLessThan(bindIndex);
    expect(bindIndex).toBeLessThan(activationGateIndex);
    expect(activationGateIndex).toBeLessThan(mediaGateIndex);
    expect(mediaGateIndex).toBeLessThan(initializeIndex);
    expect(initializeIndex).toBeLessThan(publishIndex);
    expect(publishIndex).toBeLessThan(backgroundIndex);
    expect(backgroundIndex).toBeLessThan(readyIndex);
    expect(controller).toContain('observePlayStep("DIRECT_BACKGROUND_GET_ME"');
    expect(controller).toContain('observePlayStep("DIRECT_BACKGROUND_GET_CHAT"');
    expect(controller).not.toContain('observePlayStep("DIRECT_VERIFY"');
    expect(controller).not.toContain("const [activationResult, initializeResult] = await Promise.all([");
    expect(controller).toContain("if (activationResultPromise) await activationResultPromise;");
    expect(controller).toContain("if (bootstrap) await this.api.stop(bootstrap).catch(() => {});");
  });

  it("resolves an existing beat topic by vault rather than installation", () => {
    const server = source("cloud-server/server-core.js");
    const transport = source("src/features/cloud/webGalerCloudTransport.ts");
    expect(server).toContain("function storedBeatTopicCandidates(chatId, userId, beatId)");
    expect(server).toContain("key.endsWith(suffix)");
    expect(server).toContain("Number(current?.chatId) === Number(chatId)");
    expect(server).toContain("Number(a.messageThreadId) - Number(b.messageThreadId)");
    expect(server).toContain("adoptCanonicalBeatTopic(chatId, userId, beatId, name, current)");
    expect(transport).not.toContain("hintedThreadId");
    expect(transport).toContain("return { ...uploaded, thread_id: threadId };");
  });

  it("routes browser drops through browser File owners, not Desktop path staging", () => {
    const app = source("src/App.tsx");
    const controller = source("src/features/dragdrop/htmlDropController.ts");
    expect(app).toContain("onBrowserLibraryFileDrop: platform.capabilities.browserFileImport ? importDroppedBrowserFiles : undefined");
    expect(app).toContain("onBrowserBeatFileDrop: platform.capabilities.browserFileImport ? handleBrowserBeatFileDrop : undefined");
    expect(app).toContain("platform.cloudData.commitImportedBeat(beat)");
    expect(controller).toContain("options.onBrowserBeatFileDrop");
  });

  it("does not let Web card warming queue native cooking ahead of Play", () => {
    const app = source("src/App.tsx");
    expect(app).toContain("if (!platform.capabilities.playbackCache) return;");
    expect(app).toContain("Math.min(isTauriAvailable ? 6 : 1, queue.length)");
  });
});