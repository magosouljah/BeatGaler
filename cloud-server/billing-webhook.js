'use strict';

class WebhookSignatureError extends Error {
  constructor(message = 'Webhook signature verification failed.') {
    super(message);
    this.name = 'WebhookSignatureError';
    this.code = 'WEBHOOK_INVALID_SIGNATURE';
  }
}

class WebhookDeliveryError extends Error {
  constructor(message = 'Webhook processing failed.') {
    super(message);
    this.name = 'WebhookDeliveryError';
    this.code = 'WEBHOOK_PROCESSING_FAILED';
  }
}

class WebhookIdentityError extends Error {
  constructor(message = 'Webhook event identity collision.') {
    super(message);
    this.name = 'WebhookIdentityError';
    this.code = 'WEBHOOK_IDENTITY_COLLISION';
  }
}

function requireRawBody(rawBody) {
  if (!Buffer.isBuffer(rawBody)) throw new WebhookSignatureError('Webhook raw body Buffer is required.');
  return rawBody;
}

function normalizeVerifiedEvent(event) {
  if (!event || typeof event !== 'object') throw new WebhookSignatureError('Verifier returned no event.');
  const id = String(event.id || '').trim();
  const type = String(event.type || '').trim();
  const subjectId = String(event.data?.object?.id || '').trim();
  const created = Number(event.created);
  if (!id || !type || !subjectId || !Number.isFinite(created)) throw new WebhookSignatureError('Verified event identity is incomplete.');
  return Object.freeze({ ...event, id, type, subjectId, created });
}

function createPostgresWebhookRepository(pool) {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') throw new Error('PostgreSQL pool is required.');
  return Object.freeze({
    async process(event, handler) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const inserted = await client.query(`INSERT INTO billing_webhook_events(
          event_id,event_type,subject_id,provider_created_at,state,attempt_count,created_at,updated_at)
          VALUES($1,$2,$3,$4,'PROCESSING',1,now(),now())
          ON CONFLICT(event_id) DO NOTHING RETURNING event_id`, [event.id,event.type,event.subjectId,event.created]);
        if (!inserted.rows.length) {
          const existing = (await client.query('SELECT state,event_type,subject_id,provider_created_at FROM billing_webhook_events WHERE event_id=$1 FOR UPDATE', [event.id])).rows[0];
          if (!existing) throw new Error('Webhook idempotency race produced no row.');
          if (existing.event_type !== event.type || existing.subject_id !== event.subjectId || Number(existing.provider_created_at) !== event.created) {
            throw new WebhookIdentityError();
          }
          if (existing.state !== 'FAILED') {
            await client.query('COMMIT');
            return { duplicate: true, state: existing.state };
          }
          await client.query("UPDATE billing_webhook_events SET state='PROCESSING',attempt_count=attempt_count+1,last_error=NULL,updated_at=now() WHERE event_id=$1", [event.id]);
        }

        await client.query(`INSERT INTO billing_webhook_subjects(subject_id,last_provider_created_at,updated_at)
          VALUES($1,-1,now()) ON CONFLICT(subject_id) DO NOTHING`, [event.subjectId]);
        const watermark = (await client.query('SELECT last_provider_created_at FROM billing_webhook_subjects WHERE subject_id=$1 FOR UPDATE', [event.subjectId])).rows[0];
        if (Number(watermark.last_provider_created_at) > event.created) {
          await client.query("UPDATE billing_webhook_events SET state='IGNORED_OUT_OF_ORDER',updated_at=now() WHERE event_id=$1", [event.id]);
          await client.query('COMMIT');
          return { duplicate: false, stale: true, state: 'IGNORED_OUT_OF_ORDER' };
        }

        await handler(client, event);
        await client.query("UPDATE billing_webhook_events SET state='PROCESSED',last_error=NULL,updated_at=now() WHERE event_id=$1", [event.id]);
        await client.query('UPDATE billing_webhook_subjects SET last_provider_created_at=GREATEST(last_provider_created_at,$2),updated_at=now() WHERE subject_id=$1', [event.subjectId,event.created]);
        await client.query('COMMIT');
        return { duplicate: false, stale: false, state: 'PROCESSED' };
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        if (!(error instanceof WebhookIdentityError)) {
          try {
            await pool.query(`INSERT INTO billing_webhook_events(event_id,event_type,subject_id,provider_created_at,state,attempt_count,last_error,created_at,updated_at)
              VALUES($1,$2,$3,$4,'FAILED',1,$5,now(),now())
              ON CONFLICT(event_id) DO UPDATE SET state='FAILED',last_error=EXCLUDED.last_error,updated_at=now()
              WHERE billing_webhook_events.event_type=EXCLUDED.event_type
                AND billing_webhook_events.subject_id=EXCLUDED.subject_id
                AND billing_webhook_events.provider_created_at=EXCLUDED.provider_created_at`,
              [event.id,event.type,event.subjectId,event.created,String(error?.message || error).slice(0,500)]);
          } catch (_) {}
        }
        throw new WebhookDeliveryError();
      } finally {
        client.release();
      }
    },
  });
}

function createWebhookProcessor({ verifier, repository, handlers }) {
  if (!verifier || typeof verifier.verify !== 'function') throw new Error('Webhook verifier is required.');
  if (!repository || typeof repository.process !== 'function') throw new Error('Webhook repository is required.');
  const supported = handlers || {};
  return Object.freeze({
    async receive({ rawBody, signature }) {
      const raw = requireRawBody(rawBody);
      let verified;
      try {
        verified = await verifier.verify(raw, signature);
      } catch (_) {
        throw new WebhookSignatureError();
      }
      const event = normalizeVerifiedEvent(verified);
      const handler = supported[event.type];
      if (typeof handler !== 'function') {
        return { accepted: true, unsupported: true, eventId: event.id, entitlementGranted: false };
      }
      const result = await repository.process(event, handler);
      return { accepted: true, unsupported: false, eventId: event.id, ...result, entitlementGranted: false };
    },
  });
}

module.exports = {
  WebhookSignatureError,
  WebhookDeliveryError,
  WebhookIdentityError,
  requireRawBody,
  normalizeVerifiedEvent,
  createPostgresWebhookRepository,
  createWebhookProcessor,
};
