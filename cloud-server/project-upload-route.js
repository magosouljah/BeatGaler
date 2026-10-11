'use strict';

const fs = require('node:fs');
const multer = require('multer');
const { createProjectUploadAdmission } = require('./project-upload-admission');

function createProjectUploadHandlers({ authenticate, verifyCapability, authorizeProject,
  uploadProject, storageChatId,
  tempDir = process.env.BEATGALER_PROJECT_UPLOAD_TEMP_DIR || 'uploads-tmp/',
  uploadAdmission = createProjectUploadAdmission() }) {
  return [
    async (req, res, next) => {
      const auth = authenticate(req, res);
      if (!auth) return;
      const beatId = String(req.headers['x-beatgaler-project-beat'] || '');
      const kind = String(req.headers['x-beatgaler-project-kind'] || '');
      req.body = { ...req.body,
        beatId, kind,
        operationId: String(req.headers['x-beatgaler-project-operation'] || ''),
        sessionId: String(req.headers['x-beatgaler-project-session'] || ''),
        generation: Number(req.headers['x-beatgaler-project-generation'] || 0),
        scope: { objectType: 'beat', objectIds: [beatId] },
      };
      if ((kind !== 'commit_import' && kind !== 'commit_edit') || !beatId) {
        return res.status(403).json({ code: 'PROJECT_CAPABILITY_REQUIRED' });
      }
      try {
        await verifyCapability(req);
        const allowed = await authorizeProject({ userId: auth.user.id });
        const reservation = uploadAdmission.acquire({
          maxBytes: allowed.maxBytes,
          contentLength: req.headers['content-length'],
        });
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          res.off('finish', release);
          res.off('close', release);
          reservation.release();
        };
        res.once('finish', release);
        res.once('close', release);
        req.beatgalerProjectUploadRelease = release;
        req.beatgalerProjectUpload = { userId: auth.user.id, beatId,
          chatId: storageChatId(auth.account), maxBytes: allowed.maxBytes,
          threadId: Number(req.headers['x-beatgaler-project-thread'] || 0) };
        next();
      } catch (error) {
        if (Number.isSafeInteger(error?.retryAfter) && error.retryAfter > 0) {
          res.setHeader('Retry-After', String(error.retryAfter));
        }
        res.status(Number(error?.status || 503)).json({ code: error?.code || 'PROJECT_ACCESS_UNAVAILABLE', error: error?.message });
      }
    },
    (req, res, next) => {
      // Busboy signals LIMIT_FILE_SIZE when it reaches the configured value.
      // Permit the exact plan ceiling, then stop on the first excess byte.
      multer({ dest: tempDir, limits: { files: 1, fileSize: req.beatgalerProjectUpload.maxBytes + 1 } })
        .single('file')(req, res, next);
    },
    async (req, res) => {
      if (!req.file) return res.status(400).json({ code: 'PROJECT_FILE_REQUIRED', error: 'PROJECT file is required.' });
      let status = 200;
      let body;
      try {
        const uploaded = await uploadProject({
          ...req.beatgalerProjectUpload, filePath: req.file.path, filename: req.file.originalname,
        });
        const id = uploaded.messageId;
        body = { telegram_file_id: `direct:${id}`, telegram_message_id: id,
          original_size: uploaded.bytes, filename: req.file.originalname,
          parts: [{ telegram_file_id: `direct:${id}`, telegram_message_id: id, index: 0,
            size: uploaded.bytes, filename: req.file.originalname }], transport: 'direct-web' };
      } catch (error) {
        status = Number(error?.status || 503);
        body = { code: error?.code || 'PROJECT_UPLOAD_FAILED', error: error?.message };
      } finally {
        await fs.promises.unlink(req.file.path).catch(() => {});
        req.beatgalerProjectUploadRelease?.();
      }
      return res.status(status).json(body);
    },
  ];
}

module.exports = { createProjectUploadHandlers };
