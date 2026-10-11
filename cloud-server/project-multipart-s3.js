'use strict';

const { S3Client, CreateMultipartUploadCommand, UploadPartCommand, ListPartsCommand,
  CompleteMultipartUploadCommand, AbortMultipartUploadCommand, HeadObjectCommand,
  GetObjectCommand, DeleteObjectCommand, HeadBucketCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

function s3Config(env = process.env) {
  const bucket = String(env.PROJECT_STAGING_S3_BUCKET || '').trim();
  const region = String(env.PROJECT_STAGING_AWS_REGION || '').trim();
  const kmsKeyId = String(env.PROJECT_STAGING_KMS_KEY_ID || '').trim();
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) ||
      !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region) || !kmsKeyId) {
    throw new Error('PROJECT_STAGING_CONFIG_INVALID');
  }
  return { bucket, region, kmsKeyId };
}

function createProjectS3Store({ env = process.env, client, presign = getSignedUrl } = {}) {
  const { bucket, region, kmsKeyId } = s3Config(env);
  const s3 = client || new S3Client({ region });
  const key = id => `project-staging/${id}`;
  return Object.freeze({
    bucket,
    key,
    async check() { await s3.send(new HeadBucketCommand({ Bucket: bucket })); return true; },
    async create(id) {
      const result = await s3.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key(id),
        ChecksumAlgorithm: 'SHA256', ServerSideEncryption: 'aws:kms', SSEKMSKeyId: kmsKeyId,
        ContentType: 'application/zip' }));
      if (!result.UploadId) throw new Error('PROJECT_STAGING_CREATE_UNCONFIRMED');
      return result.UploadId;
    },
    async signPart(id, uploadId, partNumber, checksum, sizeBytes) {
      const command = new UploadPartCommand({ Bucket: bucket, Key: key(id), UploadId: uploadId,
        PartNumber: partNumber, ChecksumSHA256: checksum, ContentLength: sizeBytes });
      const url = await presign(s3, command, { expiresIn: 600,
        unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
        signableHeaders: new Set(['content-length']) });
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.amazonaws.com')) {
        throw new Error('PROJECT_STAGING_URL_INVALID');
      }
      return { url, headers: { 'x-amz-checksum-sha256': checksum } };
    },
    async parts(id, uploadId) {
      const result = await s3.send(new ListPartsCommand({ Bucket: bucket, Key: key(id),
        UploadId: uploadId, MaxParts: 1000 }));
      if (result.IsTruncated) throw new Error('PROJECT_STAGING_PARTS_TRUNCATED');
      return (result.Parts || []).map(part => ({ number: part.PartNumber,
        size: Number(part.Size), checksum: part.ChecksumSHA256, etag: part.ETag }));
    },
    async complete(id, uploadId, parts) {
      await s3.send(new CompleteMultipartUploadCommand({ Bucket: bucket, Key: key(id),
        UploadId: uploadId, MultipartUpload: { Parts: parts.map(part => ({
          PartNumber: part.number, ETag: part.etag, ChecksumSHA256: part.checksum,
        })) } }));
    },
    async head(id) {
      try {
        const result = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key(id) }));
        return Number(result.ContentLength);
      } catch (error) {
        if (['NotFound', 'NoSuchKey'].includes(error?.name) || error?.$metadata?.httpStatusCode === 404) return null;
        throw error;
      }
    },
    async stream(id, signal) {
      const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key(id) }),
        { abortSignal: signal });
      if (!result.Body || typeof result.Body.pipe !== 'function') throw new Error('PROJECT_STAGING_BODY_INVALID');
      return result.Body;
    },
    async abort(id, uploadId) {
      if (uploadId) {
        try { await s3.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key(id), UploadId: uploadId })); }
        catch (error) { if (error?.name !== 'NoSuchUpload') throw error; }
      }
    },
    async remove(id) { await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key(id) })); },
  });
}

module.exports = { s3Config, createProjectS3Store };
