'use strict';

const { createAccessRuntime } = require('./access-runtime');

class ProjectAccessError extends Error {
  constructor(message, code, status = 403) {
    super(message);
    this.name = 'ProjectAccessError';
    this.code = code;
    this.status = status;
  }
}

function deny(message, code, status) { throw new ProjectAccessError(message, code, status); }

function projectMessageId(beat) {
  const project = beat?.project;
  if (project == null) return 0;
  if (!project || typeof project !== 'object' || Array.isArray(project)) {
    deny('PROJECT reference is invalid.', 'PROJECT_REFERENCE_INVALID', 400);
  }
  const manifest = project.manifest;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    deny('PROJECT manifest is missing.', 'PROJECT_REFERENCE_INVALID', 400);
  }
  const parts = manifest.parts;
  if (!Array.isArray(parts) || parts.length !== 1) {
    deny('PROJECT must reference exactly one Telegram document.', 'PROJECT_REFERENCE_INVALID', 400);
  }
  const id = Number(manifest.telegram_message_id);
  const partId = Number(parts[0]?.telegram_message_id);
  if (!Number.isSafeInteger(id) || id <= 0 || partId !== id ||
      manifest.telegram_file_id !== `direct:${id}` || parts[0]?.telegram_file_id !== `direct:${id}`) {
    deny('PROJECT document reference is inconsistent.', 'PROJECT_REFERENCE_INVALID', 400);
  }
  return id;
}

function projectRows(manifest) {
  const rows = new Map();
  for (const row of manifest.beats || []) rows.set(String(row.id), row);
  for (const item of manifest.trash || []) rows.set(String(item?.beat?.id), item.beat);
  return rows;
}

function declaredProjectBytes(beat) {
  const project = beat.project;
  const values = [project.size, project.manifest.original_size, project.manifest.parts[0].size];
  if (values.some(value => !Number.isSafeInteger(value) || value <= 0 || value !== values[0])) {
    deny('PROJECT byte metadata is inconsistent.', 'PROJECT_SIZE_MISMATCH', 400);
  }
  return values[0];
}

function createProjectAccess({ pool, projectUploads }) {
  if (!pool?.query) throw new Error('Access PostgreSQL reader is required.');

  async function policy(userId) {
    const access = await createAccessRuntime({ pool }).resolveUserAccess({ id: userId });
    if (!access?.capabilities?.upload_project) deny('PROJECT upload is not available on this plan.', 'PROJECT_UPLOAD_DENIED');
    const maxBytes = access.quotas.max_project_zip_bytes;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) deny('PROJECT byte limit is unavailable.', 'PROJECT_UPLOAD_DENIED');
    return maxBytes;
  }

  async function authorize({ userId, declaredBytes }) {
    const maxBytes = await policy(userId);
    if (declaredBytes !== undefined && declaredBytes !== null &&
        (!Number.isSafeInteger(declaredBytes) || declaredBytes <= 0 || declaredBytes > maxBytes)) {
      deny('PROJECT exceeds the plan byte limit.', 'PROJECT_TOO_LARGE', 413);
    }
    return { maxBytes };
  }

  async function verifyChanges({ client, userId, chatId, previousManifest, candidateManifest }) {
    const previous = projectRows(previousManifest || { beats: [], trash: [] });
    const candidate = projectRows(candidateManifest);
    let maxBytes = null;
    let largestMeasured = 0;
    for (const [beatId, beat] of candidate) {
      if (beat?.project == null) continue;
      // Preserve old PROJECT objects byte-for-byte across metadata edits and
      // downgrades, including older manifest formats. Any changed object must
      // prove the complete single-document reference and current Access.
      if (JSON.stringify(beat.project) === JSON.stringify(previous.get(beatId)?.project)) continue;
      const nextId = projectMessageId(beat);
      if (maxBytes === null) maxBytes = await policy(userId);
      if (!projectUploads) deny('PROJECT upload receipt is unavailable.', 'PROJECT_UPLOAD_UNVERIFIED');
      const declaredBytes = declaredProjectBytes(beat);
      // MASTER uploads are measured from the received file stream and recorded
      // in PostgreSQL. A bot-only/generic upload has no receipt and cannot be
      // promoted to a valid PROJECT through a forged INDEX.
      const measured = await projectUploads.verifyPublished({ client, userId, beatId,
        chatId, messageId: nextId, sizeBytes: declaredBytes, maxBytes });
      if (measured !== declaredBytes) deny('PROJECT byte metadata does not match the persisted document.', 'PROJECT_SIZE_MISMATCH', 400);
      largestMeasured = Math.max(largestMeasured, measured);
    }
    if (maxBytes !== null && largestMeasured > await policy(userId)) {
      deny('PROJECT exceeds the current plan byte limit.', 'PROJECT_TOO_LARGE', 413);
    }
  }

  return Object.freeze({ authorize, verifyChanges });
}

module.exports = { ProjectAccessError, projectMessageId, createProjectAccess };
