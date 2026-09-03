import {
  activateWebTransportSession,
  authorizeWebTransportOperation,
  beginWebTransportOperation,
  bindWebTransportSession,
  endWebTransportOperation,
  heartbeatWebTransportSession,
  reserveWebTransportSession,
  stopWebTransportSession,
  type WebTransportCapabilityScope,
  type WebTransportSession,
  type WebTransportSessionPublic,
} from "./webTransportSession";
import { playTrace, observePlayStep } from "../playback/playTrace";

export interface WebTransportRuntime {
  initialize(session: WebTransportSession): Promise<void>;
  replaceCredentials(session: WebTransportSession): Promise<void>;
  verifyReady(session: WebTransportSession): Promise<void>;
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
  }>;
  end(session: Pick<WebTransportSession, "session_id" | "generation">, operationId: string): Promise<void>;
  stop(session: Pick<WebTransportSessionPublic, "session_id" | "generation">): Promise<void>;
}

export interface WebTransportOperationLease {
  operationId: string;
  sessionId: string;
  generation: number;
  scope: WebTransportCapabilityScope;
}

const defaultApi: WebTransportControlApi = {
  reserve: reserveWebTransportSession,
  bind: bindWebTransportSession,
  activate: activateWebTransportSession,
  authorize: authorizeWebTransportOperation,
  heartbeat: heartbeatWebTransportSession,
  begin: beginWebTransportOperation,
  end: endWebTransportOperation,
  stop: stopWebTransportSession,
};

const wait = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));

type StartupBranchResult =
  | { ok: true }
  | { ok: false; error: unknown };

async function settleStartupBranch(work: Promise<void>): Promise<StartupBranchResult> {
  try {
    await work;
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

/** Owns the Web lease. Credentials remain in memory and are handed only to the data-plane runtime. */
export class WebTransportController {
  private session: WebTransportSession | null = null;
  private connectPromise: Promise<WebTransportSession> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(
    private readonly runtime: WebTransportRuntime,
    private readonly api: WebTransportControlApi = defaultApi,
  ) {}

  async connect(): Promise<WebTransportSession> {
    if (this.closed) throw new Error("Galer Cloud Web transport is closed.");
    if (this.session) {
      playTrace("CONTROLLER_CONNECT_REUSE");
      return this.session;
    }
    if (this.connectPromise) {
      playTrace("CONTROLLER_CONNECT_JOIN");
      return this.connectPromise;
    }
    playTrace("CONTROLLER_CONNECT_NEW");
    this.connectPromise = this.openSession().finally(() => { this.connectPromise = null; });
    return this.connectPromise;
  }

  private async openSession(): Promise<WebTransportSession> {
    const started = Date.now();
    let bootstrap: WebTransportSessionPublic | null = null;
    let activationResultPromise: Promise<StartupBranchResult> | null = null;
    let activationSnapshot: StartupBranchResult | null = null;

    playTrace("CONTROLLER_SESSION_PREPARE_BEGIN");
    try {
      const session = await observePlayStep("DIRECT_PREPARE", async () => {
        bootstrap = await this.api.reserve();

        // Activation only needs the reserved lease identity. Start MASTER/vault
        // membership work immediately while the browser creates and binds its
        // fresh temporary MTProto authorization. Capture rejection now so a
        // temp-auth failure can wait for activation to settle before cleanup.
        const activateStarted = Date.now();
        activationResultPromise = settleStartupBranch(
          observePlayStep("DIRECT_ACTIVATE", () => this.api.activate(bootstrap!)),
        ).then(result => {
          activationSnapshot = result;
          if (result.ok) {
            playTrace("CONTROLLER_SESSION_ACTIVATE_DONE", { elapsed_ms: Date.now() - activateStarted });
          }
          return result;
        });

        return this.api.bind(bootstrap);
      });
      playTrace("CONTROLLER_SESSION_PREPARE_DONE", { elapsed_ms: Date.now() - started });

      // If activation already failed while temp auth was binding, do not start
      // a Worker that can never become ready. Otherwise initialize overlaps the
      // remainder of activation and both branches are joined below.
      if (activationSnapshot && !activationSnapshot.ok) throw activationSnapshot.error;
      if (!activationResultPromise) throw new Error("Galer Cloud Web activation did not start after lease reservation.");

      const initializeStarted = Date.now();
      const initializeResultPromise = settleStartupBranch(
        observePlayStep("DIRECT_INITIALIZE", () => this.runtime.initialize(session)),
      ).then(result => {
        if (result.ok) {
          playTrace("CONTROLLER_SESSION_INITIALIZE_DONE", { elapsed_ms: Date.now() - initializeStarted });
        }
        return result;
      });

      // Do not use a rejecting Promise.all here. Waiting for both branches is a
      // teardown invariant: if either side fails, the other must finish/fail
      // before stop() is allowed to remove the bot and release the lease.
      const [activationResult, initializeResult] = await Promise.all([
        activationResultPromise,
        initializeResultPromise,
      ]);
      const failed = [activationResult, initializeResult].find(result => !result.ok);
      if (failed && !failed.ok) throw failed.error;

      const verifyStarted = Date.now();
      await observePlayStep("DIRECT_VERIFY", () => this.runtime.verifyReady(session));
      playTrace("CONTROLLER_SESSION_VERIFY_DONE", { elapsed_ms: Date.now() - verifyStarted });
      this.session = session;
      playTrace("CONTROLLER_SESSION_READY", { total_ms: Date.now() - started });
      this.scheduleHeartbeat(session.heartbeat_interval_ms);
      return session;
    } catch (error) {
      // bind() can fail while activation is still mutating Telegram membership.
      // Never stop/release first: activation could otherwise re-add the bot after
      // cleanup. Its result is already rejection-safe via settleStartupBranch().
      if (activationResultPromise) await activationResultPromise;
      await this.runtime.shutdown().catch(() => {});
      if (bootstrap) await this.api.stop(bootstrap).catch(() => {});
      throw error;
    }
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
      // The control plane owns expiry. A short outage must not discard a valid lease.
      this.scheduleHeartbeat(Math.min(5000, session.heartbeat_interval_ms));
    }
  }

  private async applyCredentialRefresh(session: WebTransportSession): Promise<void> {
    await this.runtime.replaceCredentials(session);
    this.session = session;
  }

  private async resetLocalSession(): Promise<void> {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.session = null;
    await this.runtime.shutdown().catch(() => {});
  }

  async beginOperation(kind: string, scope: WebTransportCapabilityScope): Promise<WebTransportOperationLease> {
    const deadline = Date.now() + 120_000;
    while (!this.closed && Date.now() < deadline) {
      const session = await this.connect();
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
          await this.api.end({ session_id: session.session_id, generation: session.generation }, response.operationId).catch(() => {});
          throw error;
        }
        return {
          operationId: response.operationId,
          sessionId: session.session_id,
          generation: session.generation,
          scope,
        };
      }
      throw new Error("Galer Cloud returned incomplete operation information.");
    }
    throw new Error("Galer Cloud is still waiting for another transfer to finish.");
  }

  async endOperation(lease: WebTransportOperationLease): Promise<void> {
    await this.api.end({ session_id: lease.sessionId, generation: lease.generation }, lease.operationId);
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
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
    const session = this.session;
    this.session = null;
    await this.runtime.shutdown().catch(() => {});
    if (session) await this.api.stop(session).catch(() => {});
  }
}