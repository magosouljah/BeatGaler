import {
  activateWebTransportSession,
  authorizeWebTransportOperation,
  beginWebTransportOperation,
  bindWebTransportSession,
  endWebTransportOperation,
  heartbeatWebTransportSession,
  renewWebTransportOperation,
  reserveWebTransportSession,
  stopWebTransportSession,
  type WebTransportCapabilityScope,
  type WebTransportSession,
  type WebTransportSessionPublic,
} from "./webTransportSession";
import { playTrace, observePlayStep } from "../playback/playTrace";

export interface WebTransportRuntime {
  initialize(session: WebTransportSession, startupMessageIds: readonly number[]): Promise<void>;
  replaceCredentials(session: WebTransportSession): Promise<void>;
  verifyIdentity(session: WebTransportSession): Promise<void>;
  verifyReady(session: WebTransportSession): Promise<void>;
  /** Irrevocably terminates the Worker without waiting for graceful cleanup. */
  abortImmediately?(): void;
  shutdown(): Promise<void>;
}

export interface WebTransportControlApi {
  reserve(): Promise<WebTransportSessionPublic>;
  bind(bootstrap: WebTransportSessionPublic): Promise<WebTransportSession>;
  activate(session: WebTransportSessionPublic): Promise<void>;
  heartbeat(session: WebTransportSession): Promise<{ expired: boolean; credentialRefresh: WebTransportSession | null }>;
  authorize(session: WebTransportSession, operationId: string, kind: string, scope: WebTransportCapabilityScope): Promise<void>;
  begin(session: WebTransportSession, kind: string, scope: WebTransportCapabilityScope): Promise<{
    expired: boolean;
    waitMs: number | null;
    credentialRefresh: WebTransportSession | null;
    operationId: string | null;
    livenessTimeoutMs?: number | null;
  }>;
  renew?(session: Pick<WebTransportSession, "session_id" | "generation">, operationId: string): Promise<{
    expired: boolean;
    livenessTimeoutMs?: number | null;
  }>;
  end(session: Pick<WebTransportSession, "session_id" | "generation">, operationId: string): Promise<void>;
  stop(session: Pick<WebTransportSessionPublic, "session_id" | "generation">): Promise<void>;
}

export interface WebTransportOperationLease {
  operationId: string;
  sessionId: string;
  generation: number;
  scope: WebTransportCapabilityScope;
  livenessTimeoutMs: number;
}

export interface WebTransportStartupConfig {
  startupMessageIds: readonly number[];
}

const defaultApi: WebTransportControlApi = {
  reserve: reserveWebTransportSession,
  bind: bindWebTransportSession,
  activate: activateWebTransportSession,
  authorize: authorizeWebTransportOperation,
  heartbeat: heartbeatWebTransportSession,
  begin: beginWebTransportOperation,
  renew: renewWebTransportOperation,
  end: endWebTransportOperation,
  stop: stopWebTransportSession,
};

const wait = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
const MAX_STARTUP_BEATS = 14;
const OPERATION_LIVENESS_RENEW_INTERVAL_MS = 4_000;
const DEFAULT_OPERATION_LIVENESS_TIMEOUT_MS = 15_000;

interface OperationLivenessTimers {
  renewal: ReturnType<typeof setTimeout> | null;
  watchdog: ReturnType<typeof setTimeout> | null;
  timeoutMs: number;
}

type StartupBranchResult = { ok: true } | { ok: false; error: unknown };

async function settleStartupBranch(work: Promise<void>): Promise<StartupBranchResult> {
  try {
    await work;
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

function normalizeStartupMessageIds(values: readonly number[]): number[] {
  const output: number[] = [];
  const seen = new Set<number>();
  for (const value of values) {
    const id = Number(value || 0);
    if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    output.push(id);
    if (output.length >= MAX_STARTUP_BEATS) break;
  }
  return output;
}

/** Owns the Web lease and the local startup message-vector handoff to the Worker. */
export class WebTransportController {
  private session: WebTransportSession | null = null;
  private connectPromise: Promise<WebTransportSession> | null = null;
  private refreshPromise: Promise<void> | null = null;
  private verificationPromise: Promise<void> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private operationLivenessTimers = new Map<string, OperationLivenessTimers>();
  private closed = false;
  private lifecycleGeneration = 0;
  private readonly startupMessageIds: number[];

  constructor(
    private readonly runtime: WebTransportRuntime,
    private readonly api: WebTransportControlApi = defaultApi,
    startup: WebTransportStartupConfig = { startupMessageIds: [] },
  ) {
    this.startupMessageIds = normalizeStartupMessageIds(startup.startupMessageIds);
  }

  private isCurrentLifecycle(generation: number): boolean {
    return !this.closed && generation === this.lifecycleGeneration;
  }

  async connect(): Promise<WebTransportSession> {
    if (this.closed) throw new Error("Galer Cloud Web transport is closed.");
    if (this.refreshPromise) {
      playTrace("CONTROLLER_CONNECT_REFRESH_WAIT");
      await this.refreshPromise;
    }
    if (this.session) {
      playTrace("CONTROLLER_CONNECT_REUSE");
      return this.session;
    }
    if (this.connectPromise) {
      playTrace("CONTROLLER_CONNECT_JOIN");
      return this.connectPromise;
    }
    playTrace("CONTROLLER_CONNECT_NEW", { startup_beat_count: this.startupMessageIds.length });
    const lifecycleGeneration = this.lifecycleGeneration;
    this.connectPromise = this.openSession(lifecycleGeneration).finally(() => { this.connectPromise = null; });
    return this.connectPromise;
  }

  private async openSession(lifecycleGeneration: number): Promise<WebTransportSession> {
    const started = Date.now();
    let bootstrap: WebTransportSessionPublic | null = null;
    let activationResultPromise: Promise<StartupBranchResult> | null = null;

    playTrace("CONTROLLER_SESSION_PREPARE_BEGIN", { startup_beat_count: this.startupMessageIds.length });
    try {
      // The new Web client owns startup routing locally. Do not request Cloud
      // startup routes on the playback-critical reservation response.
      bootstrap = await this.api.reserve();
      if (!this.isCurrentLifecycle(lifecycleGeneration)) throw new Error("Galer Cloud Web transport startup was superseded.");

      const activateStarted = Date.now();
      activationResultPromise = settleStartupBranch(
        observePlayStep("DIRECT_ACTIVATE", () => this.api.activate(bootstrap!)),
      ).then(result => {
        if (result.ok) playTrace("CONTROLLER_SESSION_ACTIVATE_DONE", { elapsed_ms: Date.now() - activateStarted });
        return result;
      });

      const session = await observePlayStep("DIRECT_PREPARE", () => this.api.bind(bootstrap!));
      if (!this.isCurrentLifecycle(lifecycleGeneration)) throw new Error("Galer Cloud Web transport startup was superseded.");
      playTrace("CONTROLLER_SESSION_PREPARE_DONE", {
        elapsed_ms: Date.now() - started,
        startup_message_count: this.startupMessageIds.length,
      });

      const activationResult = await activationResultPromise;
      if (!activationResult.ok) throw activationResult.error;
      if (!this.isCurrentLifecycle(lifecycleGeneration)) throw new Error("Galer Cloud Web transport startup was superseded.");
      playTrace("CONTROLLER_SESSION_MEDIA_GATE_OPEN");

      const initializeStarted = Date.now();
      await observePlayStep("DIRECT_INITIALIZE", async () => {
        await this.runtime.initialize(session, this.startupMessageIds);
      });
      if (!this.isCurrentLifecycle(lifecycleGeneration)) throw new Error("Galer Cloud Web transport startup was superseded.");
      playTrace("CONTROLLER_SESSION_INITIALIZE_DONE", { elapsed_ms: Date.now() - initializeStarted });

      // MTProto + startup-media setup is the playback readiness boundary.
      // Identity/vault verification is intentionally background work so it does
      // not extend OPEN->AUDIO or CLICK PLAY->AUDIO.
      this.session = session;
      this.scheduleHeartbeat(session.heartbeat_interval_ms);
      this.startBackgroundVerification(session, lifecycleGeneration);
      playTrace("CONTROLLER_SESSION_DATA_PLANE_READY", { total_ms: Date.now() - started });
      return session;
    } catch (error) {
      if (activationResultPromise) await activationResultPromise;
      await this.runtime.shutdown().catch(() => {});
      if (bootstrap) await this.api.stop(bootstrap).catch(() => {});
      throw error;
    }
  }

  private startBackgroundVerification(session: WebTransportSession, lifecycleGeneration = this.lifecycleGeneration): void {
    const verification = (async () => {
      try {
        await Promise.all([
          observePlayStep("DIRECT_BACKGROUND_GET_ME", () => this.runtime.verifyIdentity(session)),
          observePlayStep("DIRECT_BACKGROUND_GET_CHAT", () => this.runtime.verifyReady(session)),
        ]);
        if (this.session === session && this.isCurrentLifecycle(lifecycleGeneration)) playTrace("CONTROLLER_BACKGROUND_VERIFY_READY");
      } catch (error) {
        playTrace("CONTROLLER_BACKGROUND_VERIFY_FAILED", {
          error_name: error instanceof Error ? error.name : "unknown",
        });
        await this.failClosedSession(session);
        throw error;
      }
    })();
    this.verificationPromise = verification;
    void verification.catch(() => {});
    void verification.finally(() => {
      if (this.verificationPromise === verification) this.verificationPromise = null;
    }).catch(() => {});
  }

  private async waitUntilVerified(): Promise<void> {
    const verification = this.verificationPromise;
    if (verification) await verification;
    if (!this.session) throw new Error("Galer Cloud Web transport verification failed.");
  }

  private async failClosedSession(session: WebTransportSession, runtimeAlreadyFenced = false): Promise<void> {
    if (this.session !== session) return;
    this.lifecycleGeneration += 1;
    this.stopAllOperationLiveness();
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.session = null;
    if (!runtimeAlreadyFenced) await this.runtime.shutdown().catch(() => {});
    await this.api.stop(session).catch(() => {});
  }

  private scheduleHeartbeat(milliseconds: number): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    if (this.closed || !this.session) return;
    const delay = Math.max(1000, Number(milliseconds) || 60_000);
    this.heartbeatTimer = setTimeout(() => { void this.sendHeartbeat(); }, delay);
  }

  private async sendHeartbeat(): Promise<void> {
    const session = this.session;
    if (!session || this.closed) return;
    try {
      const response = await this.api.heartbeat(session);
      if (response.expired) {
        await this.resetLocalSession();
        return;
      }
      if (response.credentialRefresh) await this.applyCredentialRefresh(response.credentialRefresh);
      this.scheduleHeartbeat(this.session?.heartbeat_interval_ms || session.heartbeat_interval_ms);
    } catch {
      this.scheduleHeartbeat(Math.min(5000, session.heartbeat_interval_ms));
    }
  }

  private async applyCredentialRefresh(session: WebTransportSession): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    const lifecycleGeneration = this.lifecycleGeneration;
    const refresh = (async () => {
      playTrace("CONTROLLER_CREDENTIAL_REFRESH_BEGIN");
      try {
        await this.runtime.replaceCredentials(session);
        await Promise.all([
          this.runtime.verifyIdentity(session),
          this.runtime.verifyReady(session),
        ]);
        if (!this.isCurrentLifecycle(lifecycleGeneration)) {
          throw new Error("Galer Cloud Web transport refresh was superseded.");
        }
        this.session = session;
        playTrace("CONTROLLER_CREDENTIAL_REFRESH_READY");
      } catch (error) {
        playTrace("CONTROLLER_CREDENTIAL_REFRESH_FAILED", {
          error_name: error instanceof Error ? error.name : "unknown",
        });
        if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
        this.heartbeatTimer = null;
        if (this.isCurrentLifecycle(lifecycleGeneration)) this.lifecycleGeneration += 1;
        this.stopAllOperationLiveness();
        this.session = null;
        await this.runtime.shutdown().catch(() => {});
        throw error;
      }
    })();
    this.refreshPromise = refresh.finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async resetLocalSession(): Promise<void> {
    this.lifecycleGeneration += 1;
    this.stopAllOperationLiveness();
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.session = null;
    const verification = this.verificationPromise;
    this.verificationPromise = null;
    if (verification) await verification.catch(() => {});
    await this.runtime.shutdown().catch(() => {});
  }

  async beginOperation(kind: string, scope: WebTransportCapabilityScope): Promise<WebTransportOperationLease> {
    const deadline = Date.now() + 120_000;
    while (!this.closed && Date.now() < deadline) {
      const session = await this.connect();
      await this.waitUntilVerified();
      if (this.session !== session) continue;
      if (this.refreshPromise) {
        await this.refreshPromise;
        continue;
      }
      const response = await this.api.begin(session, kind, scope);
      if (response.expired) {
        await this.resetLocalSession();
        continue;
      }
      if (response.credentialRefresh) {
        await this.applyCredentialRefresh(response.credentialRefresh);
        continue;
      }
      if (response.waitMs !== null) {
        playTrace("CONTROLLER_OPERATION_WAIT", { kind, wait_ms: response.waitMs });
        await wait(response.waitMs);
        continue;
      }
      if (response.operationId) {
        try {
          await this.api.authorize(session, response.operationId, kind, scope);
        } catch (error) {
          await this.api.end(
            { session_id: session.session_id, generation: session.generation },
            response.operationId,
          ).catch(() => {});
          throw error;
        }
        const lease = {
          operationId: response.operationId,
          sessionId: session.session_id,
          generation: session.generation,
          scope,
          livenessTimeoutMs: response.livenessTimeoutMs || DEFAULT_OPERATION_LIVENESS_TIMEOUT_MS,
        };
        this.startOperationLiveness(lease);
        return lease;
      }
      throw new Error("Galer Cloud returned incomplete operation information.");
    }
    throw new Error("Galer Cloud is still waiting for another transfer to finish.");
  }

  async endOperation(lease: WebTransportOperationLease): Promise<void> {
    this.stopOperationLiveness(lease.operationId);
    await this.api.end({ session_id: lease.sessionId, generation: lease.generation }, lease.operationId);
  }

  private startOperationLiveness(lease: WebTransportOperationLease): void {
    if (!this.api.renew) return;
    const timeoutMs = Math.max(5_000, Number(lease.livenessTimeoutMs) || DEFAULT_OPERATION_LIVENESS_TIMEOUT_MS);
    // The server will not release an INDEX lock until its full liveness TTL.
    // Stop the local Worker well before that point so an isolated tab can never
    // keep writing Direct while another installation is admitted after expiry.
    const failClosedAfter = (value: number) => Math.max(1_000, Math.floor(value * 2 / 3));
    const renewEvery = (value: number) => Math.max(1_000, Math.min(OPERATION_LIVENESS_RENEW_INTERVAL_MS, Math.floor(value / 3)));
    const armWatchdog = () => {
      const active = this.operationLivenessTimers.get(lease.operationId);
      if (!active) return;
      if (active.watchdog) clearTimeout(active.watchdog);
      active.watchdog = setTimeout(() => {
        if (!this.operationLivenessTimers.has(lease.operationId) || this.closed) return;
        playTrace("CONTROLLER_OPERATION_LIVENESS_LOST_FAIL_CLOSED", { operation_id: lease.operationId });
        this.stopOperationLiveness(lease.operationId);
        // Worker shutdown is deliberately before the best-effort control-plane
        // stop below. This is the local fencing boundary for Direct writes.
        void this.failClosedOperationLiveness(lease);
      }, failClosedAfter(active.timeoutMs));
    };
    const renew = async () => {
      if (!this.operationLivenessTimers.has(lease.operationId) || this.closed) return;
      try {
        const result = await this.api.renew!({ session_id: lease.sessionId, generation: lease.generation }, lease.operationId);
        if (result.expired) {
          playTrace("CONTROLLER_OPERATION_LIVENESS_EXPIRED", { operation_id: lease.operationId });
          this.stopOperationLiveness(lease.operationId);
          void this.failClosedOperationLiveness(lease);
          return;
        }
        const active = this.operationLivenessTimers.get(lease.operationId);
        if (!active) return;
        active.timeoutMs = Math.max(5_000, Number(result.livenessTimeoutMs) || active.timeoutMs);
        armWatchdog();
      } catch {
        // Retry while the independently armed watchdog still proves that the
        // server has acknowledged this operation recently.
        playTrace("CONTROLLER_OPERATION_LIVENESS_RETRY", { operation_id: lease.operationId });
      }
      const active = this.operationLivenessTimers.get(lease.operationId);
      if (active && !this.closed) {
        active.renewal = setTimeout(() => { void renew(); }, renewEvery(active.timeoutMs));
      }
    };
    this.stopOperationLiveness(lease.operationId);
    this.operationLivenessTimers.set(lease.operationId, { renewal: null, watchdog: null, timeoutMs });
    armWatchdog();
    const active = this.operationLivenessTimers.get(lease.operationId);
    if (active) active.renewal = setTimeout(() => { void renew(); }, renewEvery(active.timeoutMs));
  }

  private async failClosedOperationLiveness(lease: WebTransportOperationLease): Promise<void> {
    const session = this.session;
    if (!session || session.session_id !== lease.sessionId || session.generation !== lease.generation) return;
    // Do not use the graceful shutdown path here: it can wait for an active
    // Worker command, which would consume the entire fence margin before Cloud
    // is allowed to reassign the INDEX lease.
    if (this.runtime.abortImmediately) {
      try { this.runtime.abortImmediately(); } catch {}
      await this.failClosedSession(session, true);
      return;
    }
    await this.failClosedSession(session);
  }

  private stopOperationLiveness(operationId: string): void {
    const timers = this.operationLivenessTimers.get(operationId);
    if (timers?.renewal) clearTimeout(timers.renewal);
    if (timers?.watchdog) clearTimeout(timers.watchdog);
    this.operationLivenessTimers.delete(operationId);
  }

  private stopAllOperationLiveness(): void {
    for (const operationId of this.operationLivenessTimers.keys()) this.stopOperationLiveness(operationId);
  }

  async withOperation<T>(kind: string, scope: WebTransportCapabilityScope, operation: () => Promise<T>): Promise<T> {
    const lease = await this.beginOperation(kind, scope);
    try {
      return await operation();
    } finally {
      await this.endOperation(lease).catch(() => {});
    }
  }

  async disconnect(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.lifecycleGeneration += 1;
    this.stopAllOperationLiveness();
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
    const session = this.session;
    this.session = null;
    const connect = this.connectPromise;
    const refresh = this.refreshPromise;
    const verification = this.verificationPromise;
    this.verificationPromise = null;
    if (connect) await connect.catch(() => {});
    if (refresh) await refresh.catch(() => {});
    if (verification) await verification.catch(() => {});
    await this.runtime.shutdown().catch(() => {});
    if (session) await this.api.stop(session).catch(() => {});
  }
}
