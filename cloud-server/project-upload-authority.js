'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { ProjectAccessError } = require('./project-access');

async function measureProjectChunks(chunks, maxBytes) {
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  for await (const chunk of chunks) {
    if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) {
      throw new ProjectAccessError('PROJECT stream returned invalid bytes.', 'PROJECT_BYTES_UNVERIFIED', 503);
    }
    bytes += chunk.byteLength;
    if (!Number.isSafeInteger(bytes)) throw new ProjectAccessError('PROJECT byte count overflowed.', 'PROJECT_BYTES_UNVERIFIED', 503);
    if (bytes > maxBytes) throw new ProjectAccessError('PROJECT exceeds the plan byte limit.', 'PROJECT_TOO_LARGE', 413);
    hash.update(chunk);
  }
  if (!bytes) throw new ProjectAccessError('PROJECT has no received bytes.', 'PROJECT_BYTES_UNVERIFIED', 400);
  return { bytes, sha256: hash.digest('hex') };
}

function createProjectUploadAuthority({ pool, transport }) {
  if (!pool?.connect || !transport?.publishProjectFile || !transport?.verifyProjectMessage) {
    throw new Error('PostgreSQL and MASTER PROJECT transport are required.');
  }

  async function upload({ userId, beatId, chatId, filePath, filename, threadId, maxBytes }) {
    const { bytes, sha256 } = await measureProjectChunks(fs.createReadStream(filePath), maxBytes);
    const stat = await fs.promises.stat(filePath);
    if (stat.size !== bytes) throw new ProjectAccessError('PROJECT file changed during upload.', 'PROJECT_BYTES_UNVERIFIED', 503);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const owner = (await client.query('SELECT id FROM vaults WHERE user_id=$1 AND telegram_chat_id=$2 FOR UPDATE',
        [userId, String(chatId)])).rows[0];
      if (!owner) throw new ProjectAccessError('PROJECT vault ownership is unavailable.', 'PROJECT_SCOPE_DENIED');
      const existing = (await client.query(`SELECT message_id,telegram_document_id,size_bytes FROM library_project_uploads
        WHERE user_id=$1 AND beat_id=$2 AND sha256=$3`, [userId, beatId, sha256])).rows[0];
      if (existing) {
        await transport.verifyProjectMessage({ chatId, messageId: existing.message_id,
          beatId, sha256, documentId: existing.telegram_document_id, sizeBytes: Number(existing.size_bytes) });
        await client.query('COMMIT');
        return { messageId: Number(existing.message_id), bytes, sha256, status: 'same' };
      }
      const recovered = await transport.findProjectFile?.({ chatId, beatId, sha256, sizeBytes: bytes });
      const sent = recovered || await transport.publishProjectFile({ chatId, filePath, filename, beatId, sha256,
        sizeBytes: bytes, threadId });
      if (!Number.isSafeInteger(sent?.messageId) || sent.messageId <= 0 || !sent.documentId) {
        throw new ProjectAccessError('MASTER did not confirm PROJECT storage.', 'PROJECT_BYTES_UNVERIFIED', 503);
      }
      await transport.verifyProjectMessage({ chatId, messageId: sent.messageId,
        beatId, sha256, documentId: sent.documentId, sizeBytes: bytes });
      await client.query(`INSERT INTO library_project_uploads
        (user_id,beat_id,sha256,message_id,telegram_document_id,size_bytes)
        VALUES($1,$2,$3,$4,$5,$6)`, [userId, beatId, sha256, sent.messageId, sent.documentId, bytes]);
      await client.query('COMMIT');
      return { messageId: sent.messageId, bytes, sha256, status: 'uploaded' };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  async function verifyPublished({ client, userId, beatId, chatId, messageId, sizeBytes, maxBytes }) {
    const row = (await client.query(`SELECT sha256,telegram_document_id,size_bytes FROM library_project_uploads
      WHERE user_id=$1 AND beat_id=$2 AND message_id=$3`, [userId, beatId, messageId])).rows[0];
    if (!row) throw new ProjectAccessError('PROJECT was not uploaded through MASTER.', 'PROJECT_UPLOAD_UNVERIFIED');
    const actual = Number(row.size_bytes);
    if (actual > maxBytes) throw new ProjectAccessError('PROJECT exceeds the plan byte limit.', 'PROJECT_TOO_LARGE', 413);
    if (actual !== sizeBytes) throw new ProjectAccessError('PROJECT byte metadata differs from received bytes.', 'PROJECT_SIZE_MISMATCH', 400);
    await transport.verifyProjectMessage({ chatId, messageId, beatId, sha256: row.sha256,
      documentId: row.telegram_document_id, sizeBytes: actual });
    return actual;
  }

  return Object.freeze({ upload, verifyPublished });
}

module.exports = { measureProjectChunks, createProjectUploadAuthority };
