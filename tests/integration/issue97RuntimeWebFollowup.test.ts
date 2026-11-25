import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Issue #97 production runtime follow-up", () => {
  it("keeps visible cloud cards playable while authority is still checking", () => {
    const appShell = source("src/app/AppShell.tsx");
    const card = source("src/components/BeatCard.tsx");
    expect(appShell).toContain('playbackInteractive={connectionState !== "offline" || Boolean(beat.offline_available)}');
    expect(card).toContain("if (!playbackInteractive || playbackBlocked) {");
    expect(card).toContain("onPlay(beat);");
  });

  it("keeps a remembered cache hidden until the session confirms user.id", () => {
    const experienceGate = source("src/features/auth/AuthExperienceGate.tsx");
    const accountGate = source("src/components/AccountGate.tsx");

    expect(experienceGate).not.toContain("optimisticRememberedSession");
    expect(experienceGate.indexOf("if (account?.id) return <React.Fragment key={account.id}>{children}</React.Fragment>;")).toBeLessThan(
      experienceGate.indexOf('if (checking) return <main className="bg-auth-shell"'),
    );
    expect(experienceGate).toContain("setActiveWebAccountId(null);");

    const webSession = source("src/features/auth/webSession.ts");
    expect(webSession).toContain("let restoreBeatGalerSessionInFlight: Promise<BeatGalerAccount | null> | null = null;");
    expect(webSession).toContain("if (restoreBeatGalerSessionInFlight) return restoreBeatGalerSessionInFlight;");
    expect(webSession).toContain("restoreBeatGalerSessionInFlight = pending;");
    expect(webSession).toContain("pending.then(clear, clear);");
    expect(accountGate.indexOf("if (account?.id) return <>{children}")).toBeLessThan(
      accountGate.indexOf('if (checking) return <div className="bg-account-loading"'),
    );
    expect(accountGate).not.toContain("optimisticRememberedSession");
  });

  it("keeps Gallery behind authentication and preserves Direct startup ordering", () => {
    const main = source("src/main.tsx");
    const experience = source("src/app/WebExperience.tsx");
    const galleryEntry = source("src/app/WebGalleryEntry.tsx");
    const galleryWorkspace = source("src/app/WebGalleryWorkspace.tsx");
    const experienceGate = source("src/features/auth/AuthExperienceGate.tsx");
    const webSignIn = source("src/features/auth/webSignIn.ts");
    const webSession = source("src/features/auth/webSession.ts");
    const workerClient = source("src/features/cloud/webTransportWorkerClient.ts");
    const controller = source("src/features/cloud/webTransportController.ts");
    const sessionControl = source("src/features/cloud/webTransportSession.ts");
    const sessionBootstrap = source("src/features/auth/webSessionBootstrap.ts");


    expect(main).toContain('import WebExperience from "./app/WebExperience";');
    expect(main).not.toContain("preconnectRememberedWebDirect();");
    expect(main).not.toContain('void import("./features/playback/webStartupPlaybackCoordinator").then(');
    expect(main).not.toContain("platform.cloudAuth.syncSession(null, \"\")");
    expect(main).not.toContain("new WebGalerCloudTransport");

    expect(experience).toContain('path === "/" ? <LandingPage />');
    expect(galleryEntry).toContain('<AuthExperienceGate initialPhase={initialPhase} onAuthenticated={accountReady}>');
    expect(experienceGate).toContain('if (account?.id) return <React.Fragment key={account.id}>{children}</React.Fragment>;');
    // T25: la Gallery no monta App ni esta preconexión (comportamiento en webGalleryWorkspaceComposition.behavior.test.tsx).
    expect(galleryWorkspace).not.toContain("preconnectRememberedWebDirect");
    expect(galleryWorkspace).not.toContain("<App />");

    expect(webSignIn).toContain('import("../library/catalog/catalogDirectPort")');
    expect(webSignIn).not.toContain("webRememberedDirectPreconnect");
    for (const file of ["src/features/auth/webSession.ts", "src/components/AccountGate.tsx"]) {
      expect(source(file)).not.toContain("webRememberedDirectPreconnect");
      expect(source(file)).not.toContain("webStartupPlaybackCoordinator");
    }

    expect(sessionBootstrap).toContain('WEB_CSRF_COOKIE_NAME = "__Host-beatgaler_csrf"');
    expect(sessionBootstrap).toContain("window.sessionStorage.getItem(WEB_CSRF_SESSION_KEY)");
    expect(sessionBootstrap).toContain("readWebCookieValue(document.cookie, WEB_CSRF_COOKIE_NAME)");

    expect(webSession).toContain("sync: (base = getResolvedCloudApiBase()) => platform.cloudAuth.syncSession(null, base)");
    expect(webSession).toContain("await confirmation.sync();");

    expect(workerClient).toContain("prewarm(): void {");
    expect(workerClient).toContain('playTrace("WORKER_PREWARM_BEGIN")');
    expect(workerClient).toContain("this.ensureWorker();");
    expect(workerClient).toContain("this.desiredPlaybackMessageId = id;");
    expect(workerClient).toContain('op: "playback_focus", messageId: desiredPlaybackMessageId');

    expect(sessionControl).toContain("const csrf = readWebCsrfToken();");
    expect(sessionControl).toContain('if (csrf) headers["X-BeatGaler-CSRF"] = csrf;');
    expect(sessionControl).toContain('credentials: "include"');
    expect(sessionControl).toContain("export async function reserveWebTransportSession(): Promise<WebTransportSessionPublic>");
    // Direct B (E7x) añadió un segundo parámetro opcional (TemporarySessionOptions); se fija solo el primero.
    expect(sessionControl).toContain("export async function bindWebTransportSession(bootstrap: WebTransportSessionPublic");
    expect(sessionControl).toContain("return bindWebTransportSession(await reserveWebTransportSession());");
    expect(sessionControl).not.toContain("startupBeatIds");

    const reserveIndex = controller.indexOf("bootstrap = await this.api.reserve();");
    const activateIndex = controller.indexOf('observePlayStep("DIRECT_ACTIVATE"');
    const bindIndex = controller.indexOf("this.api.bind(bootstrap!)");
    const mediaGateIndex = controller.indexOf('playTrace("CONTROLLER_SESSION_MEDIA_GATE_OPEN")');
    const initializeIndex = controller.indexOf('observePlayStep("DIRECT_INITIALIZE"');
    const publishIndex = controller.indexOf("this.session = session;", initializeIndex);
    const backgroundIndex = controller.indexOf("this.startBackgroundVerification(session, lifecycleGeneration, activation?.membership || null);", publishIndex);
    const readyIndex = controller.indexOf('playTrace("CONTROLLER_SESSION_DATA_PLANE_READY"', backgroundIndex);
    expect(reserveIndex).toBeGreaterThanOrEqual(0);
    expect(controller).not.toContain("startupBeatIds");
    expect(reserveIndex).toBeLessThan(bindIndex);
    expect(bindIndex).toBeLessThan(initializeIndex);
    expect(initializeIndex).toBeLessThan(activateIndex);
    expect(activateIndex).toBeLessThan(mediaGateIndex);
    expect(mediaGateIndex).toBeLessThan(publishIndex);
    expect(publishIndex).toBeLessThan(backgroundIndex);
    expect(backgroundIndex).toBeLessThan(readyIndex);
    expect(controller).toContain('observePlayStep("DIRECT_BACKGROUND_GET_ME"');
    expect(controller).toContain('observePlayStep("DIRECT_BACKGROUND_GET_CHAT"');
    expect(controller).not.toContain('observePlayStep("DIRECT_VERIFY"');
    expect(controller).not.toContain("const [activationResult, initializeResult] = await Promise.all([");
    expect(controller).toContain('if (!this.isCurrentLifecycle(lifecycleGeneration)) throw new Error("Galer Cloud Web transport startup was superseded.");');
    expect(controller).toContain("if (bootstrap) await this.api.stop(bootstrap).catch(() => {});");
  });

  it("keeps the retired beat-topic resolution out of the Cloud", () => {
    const server = source("cloud-server/server-core.js");
    expect(server).not.toContain("function storedBeatTopicCandidates(");
    expect(server).not.toContain("adoptCanonicalBeatTopic(");
  });

  it("routes browser drops through browser File owners, not Desktop path staging", () => {
    const app = source("src/app/useBeatGalerComposition.ts").replaceAll("../", "./");
    const uploadQueue = source("src/features/cloud/useCloudUploadQueue.ts");
    const htmlDropOwner = source("src/features/dragdrop/useHtmlLibraryDrop.ts");
    const controller = source("src/features/dragdrop/htmlDropController.ts");
    expect(app).toContain("browserFileImport: platform.capabilities.browserFileImport");
    expect(app).toContain("importDroppedBrowserFiles,");
    expect(htmlDropOwner).toContain("onBrowserLibraryFileDrop: browserFileImport ? importDroppedBrowserFiles : undefined");
    expect(htmlDropOwner).toContain("onBrowserBeatFileDrop: browserFileImport ? handleBrowserBeatFileDrop : undefined");
    expect(uploadQueue).toContain("platform.cloudData.commitImportedBeat(beat)");
    expect(controller).toContain("options.onBrowserBeatFileDrop");
  });

  it("does not let Web card warming queue native cooking ahead of Play", () => {
    const app = source("src/app/useBeatGalerComposition.ts").replaceAll("../", "./");
    const revealOwner = source("src/features/startup/useLibraryReveal.ts");
    const playbackController = source("src/features/playback/usePlaybackController.ts");
    expect(playbackController).toContain('if (!platform.capabilities.playbackCache || !cloudSessionVerified || connectionState !== "online") return;');
    expect(app).toContain("nativeParallelism: isTauriAvailable ? 6 : 1");
    expect(revealOwner).toContain("Math.min(nativeParallelism, queue.length)");
  });
});
