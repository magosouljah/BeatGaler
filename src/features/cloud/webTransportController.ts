import {
  activateWebTransportSession,
  beginWebTransportOperation,
  endWebTransportOperation,
  heartbeatWebTransportSession,
  prepareWebTransportSession,
  stopWebTransportSession,
  type WebTransportCapabilityScope,
  type WebTransportSession,
} from "./webTransportSession";

export interface WebTransportRuntime {
  initialize(session: WebTransportSession): Promise<void>;
  replaceCredentials(session: WebTransportSession): Promise<void>;
  verifyReady(session: WebTransportSession): Promise<void>;
  shutdown(): Promise<void>;
}

export interface WebTransportControlApi {
  prepare(): Promise<WebTransportSession>;
  activate(session: WebTransportSession): Promise<void>;
  heartbeat(session: WebTransportSession): Promise<{ expired: boolean; credentialRefresh: WebTransportSession | null }>;
  begin(session: WebTransportSession, kind: string, scope: WebTransportCapabilityScope): Promise<{
    expired: boolean;
    waitMs: number | null;
    credentialRefresh: WebTransportSession | null;
    operationId: string | null;
  }>;
  end(session: Pick<WebTransportSession, "session_id" | "generation">, operationId: string): Promise<void>;
  stop(session: Pick<WebTransportSession, "session_id" | "generation">): Promise<void>;
}

export interface WebTransportOperationLease {
  operationId: string;
  sessionId: string;
  generation: number;
  scope: WebTransportCapabilityScope;
}

const defaultApi: WebTransportControlApi = {
  prepare: prepareWebTransportSession,
  activate: activateWebTransportSession,
  heartbeat: heartbeatWebTransportSession,
  begin: beginWebTransportOperation,
  end: endWebTransportOperation,
  stop: stopWebTransportSession,
};

const wait = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));

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
    if (this.session) return this.session;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.openSession().finally(() => { this.connectPromise = null; });
    return this.connectPromise;
  }

  private async openSession(): Promise<WebTransportSession> {
    const session = await this.api.prepare();
    try {
      await this.runtime.initialize(session);
      await this.api.activate(session);
      await this.runtime.verifyReady(session);
      this.session = session;
      this.scheduleHeartbeat(session.heartbeat_interval_ms);
      return session;
    } catch (error) {
      await this.runtime.shutdown().catch(() => {});
      await this.api.stop(session).catch(() => {});
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
        await wait(response.waitMs);
        continue;
      }
      if (response.operationId) {
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
