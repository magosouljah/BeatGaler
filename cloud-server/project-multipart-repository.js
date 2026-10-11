'use strict';

function createProjectMultipartRepository(pool) {
  if (!pool?.query || !pool?.connect) throw new Error('PROJECT_STAGING_POSTGRES_REQUIRED');
  return Object.freeze({
    async withWorkerSlot(action) {
      const client = await pool.connect();
      let locked = false;
      try {
        const result = await client.query(`SELECT pg_try_advisory_lock(
          hashtextextended('beatgaler:project-staging:worker',0)) AS locked`);
        locked = result.rows?.[0]?.locked === true;
        return locked ? await action() : false;
      } finally {
        if (locked) await client.query(`SELECT pg_advisory_unlock(
          hashtextextended('beatgaler:project-staging:worker',0))`).catch(() => {});
        client.release();
      }
    },
    async ownsVault(userId, chatId) {
      const result = await pool.query('SELECT 1 FROM vaults WHERE user_id=$1 AND telegram_chat_id=$2',
        [userId, String(chatId)]);
      return result.rowCount === 1;
    },
    async ownsBeatOrReservation(userId, beatId) {
      const result = await pool.query(`SELECT 1 FROM library_beats
        WHERE user_id=$1 AND beat_id=$2 AND NOT EXISTS (
          SELECT 1 FROM library_trash_purges WHERE user_id=$1 AND beat_id=$2)
        UNION ALL SELECT 1 FROM library_beat_reservations
        WHERE user_id=$1 AND beat_id=$2 AND state='PENDING' AND expires_at>now()
          AND NOT EXISTS (SELECT 1 FROM library_trash_purges WHERE user_id=$1 AND beat_id=$2)
        LIMIT 1`, [userId, beatId]);
      return result.rowCount > 0;
    },
    async recentCreatedCount(userId) {
      const result = await pool.query(`SELECT count(*)::int AS n FROM library_project_multipart_uploads
        WHERE user_id=$1 AND created_at>now()-interval '1 hour'`, [userId]);
      return result.rows[0].n;
    },
    async byClient(userId, beatId, clientUploadId) {
      const result = await pool.query(`SELECT * FROM library_project_multipart_uploads
        WHERE user_id=$1 AND beat_id=$2 AND client_upload_id=$3`, [userId, beatId, clientUploadId]);
      return result.rows[0] || null;
    },
    async byId(userId, id) {
      const result = await pool.query(`SELECT * FROM library_project_multipart_uploads
        WHERE user_id=$1 AND id=$2`, [userId, id]);
      return result.rows[0] || null;
    },
    async activeForBeat(userId, beatId) {
      const result = await pool.query(`SELECT * FROM library_project_multipart_uploads
        WHERE user_id=$1 AND beat_id=$2 AND state IN ('STARTING','UPLOADING','READY','PROCESSING')`,
      [userId, beatId]);
      return result.rows[0] || null;
    },
    async activeForUser(userId) {
      const result = await pool.query(`SELECT * FROM library_project_multipart_uploads
        WHERE user_id=$1 AND state IN ('STARTING','UPLOADING','READY','PROCESSING')`, [userId]);
      return result.rows[0] || null;
    },
    async insert(row) {
      await pool.query(`INSERT INTO library_project_multipart_uploads
        (id,user_id,beat_id,client_upload_id,chat_id,thread_id,filename,fingerprint_sha256,size_bytes,object_key,state,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'STARTING',now()+interval '24 hours')`,
      [row.id, row.userId, row.beatId, row.clientUploadId, String(row.chatId), row.threadId,
        row.filename, row.fingerprint, row.sizeBytes, `project-staging/${row.id}`]);
    },
    async setUploading(id, uploadId) {
      const result = await pool.query(`UPDATE library_project_multipart_uploads
        SET s3_upload_id=$2,state='UPLOADING',updated_at=now()
        WHERE id=$1 AND state='STARTING' RETURNING *`, [id, uploadId]);
      return result.rows[0] || null;
    },
    async setReady(id) {
      const result = await pool.query(`UPDATE library_project_multipart_uploads
        SET state='READY',expires_at=now()+interval '24 hours',updated_at=now()
        WHERE id=$1 AND state='UPLOADING' RETURNING *`, [id]);
      return result.rows[0] || null;
    },
    async claim(workerId) {
      const result = await pool.query(`WITH next AS (
        SELECT id FROM library_project_multipart_uploads
        WHERE expires_at>now() AND attempt_count<5 AND
          (state='READY' OR (state='PROCESSING' AND processing_lease_until<now()))
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE library_project_multipart_uploads AS u
        SET state='PROCESSING',worker_id=$1,processing_lease_until=now()+interval '15 minutes',
          attempt_count=u.attempt_count+1,updated_at=now()
        FROM next WHERE u.id=next.id RETURNING u.*`, [workerId]);
      return result.rows[0] || null;
    },
    async heartbeat(id, workerId) {
      const result = await pool.query(`UPDATE library_project_multipart_uploads
        SET processing_lease_until=now()+interval '15 minutes',updated_at=now()
        WHERE id=$1 AND worker_id=$2 AND state='PROCESSING' RETURNING id`, [id, workerId]);
      return result.rowCount === 1;
    },
    async completeJob(id, workerId, result) {
      const updated = await pool.query(`UPDATE library_project_multipart_uploads
        SET state='COMPLETED',telegram_message_id=$3,result_sha256=$4,
          worker_id=NULL,processing_lease_until=NULL,failure_code=NULL,updated_at=now()
        WHERE id=$1 AND worker_id=$2 AND state='PROCESSING' RETURNING *`,
      [id, workerId, result.messageId, result.sha256]);
      return updated.rows[0] || null;
    },
    async releaseJob(id, workerId, code, terminal = false) {
      const updated = await pool.query(`UPDATE library_project_multipart_uploads
        SET state=CASE WHEN attempt_count>=5 OR $4 THEN 'FAILED' ELSE 'READY' END,
          worker_id=NULL,processing_lease_until=NULL,failure_code=$3,updated_at=now()
        WHERE id=$1 AND worker_id=$2 AND state='PROCESSING' RETURNING *`, [id, workerId, code, terminal]);
      return updated.rows[0] || null;
    },
    async retryFailed(id) {
      const updated = await pool.query(`UPDATE library_project_multipart_uploads
        SET state='READY',attempt_count=0,failure_code=NULL,updated_at=now()
        WHERE id=$1 AND state='FAILED' AND staged_removed_at IS NULL AND expires_at>now()
        RETURNING *`, [id]);
      return updated.rows[0] || null;
    },
    async expired(limit = 20) {
      const result = await pool.query(`SELECT * FROM library_project_multipart_uploads
        WHERE (expires_at<now() OR (state='STARTING' AND created_at<now()-interval '15 minutes')
          OR state IN ('ABORTED','COMPLETED'))
          AND state IN ('STARTING','UPLOADING','READY','FAILED','COMPLETED','ABORTED','PROCESSING')
          AND (state<>'PROCESSING' OR (expires_at<now() AND processing_lease_until<now()))
          AND staged_removed_at IS NULL
        ORDER BY expires_at LIMIT $1`, [limit]);
      return result.rows;
    },
    async markAborted(id) {
      const result = await pool.query(`UPDATE library_project_multipart_uploads SET state='ABORTED',updated_at=now()
        WHERE id=$1 AND (state IN ('STARTING','UPLOADING','READY','FAILED')
          OR (state='PROCESSING' AND expires_at<now() AND processing_lease_until<now()))
        RETURNING id`, [id]);
      return result.rowCount === 1;
    },
    async markRemoved(id) {
      await pool.query(`UPDATE library_project_multipart_uploads
        SET staged_removed_at=now(),updated_at=now() WHERE id=$1`, [id]);
    },
  });
}

module.exports = { createProjectMultipartRepository };
