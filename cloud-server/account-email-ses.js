'use strict';

const crypto = require('node:crypto');
const https = require('node:https');

const SES_SERVICE = 'ses';
const SES_API_PATH = '/v2/email/outbound-emails';
const EMAIL_TEMPLATES = Object.freeze({
  email_verification: Object.freeze({
    name: 'VERIFY_EMAIL',
    subject: 'Verify your BeatGaler email',
    intro: 'Use this one-time verification code to verify your BeatGaler email:',
  }),
  password_reset: Object.freeze({
    name: 'RESET_PASSWORD',
    subject: 'Reset your BeatGaler password',
    intro: 'Use this one-time reset code to reset your BeatGaler password:',
  }),
});

function sha256(value, encoding = 'hex') {
  return crypto.createHash('sha256').update(value).digest(encoding);
}

function hmac(key, value, encoding) {
  return crypto.createHmac('sha256', key).update(value).digest(encoding);
}

function amzDate(value) {
  return value.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderAccountEmail(kind, token, expiresAt) {
  const template = EMAIL_TEMPLATES[String(kind || '')];
  if (!template) {
    const error = new Error('Unsupported account email template.');
    error.code = 'SES_TEMPLATE_UNSUPPORTED';
    throw error;
  }
  const rawToken = String(token || '');
  const expiry = String(expiresAt || '');
  if (!rawToken || !expiry) {
    const error = new Error('Account email token and expiry are required.');
    error.code = 'SES_TEMPLATE_INPUT_INVALID';
    throw error;
  }
  const safeToken = escapeHtml(rawToken);
  const safeExpiry = escapeHtml(expiry);
  return {
    template_name: template.name,
    subject: template.subject,
    text: `${template.intro}\n\n${rawToken}\n\nExpires: ${expiry}\n\nIf you did not request this, you can ignore this email.`,
    html: `<p>${escapeHtml(template.intro)}</p><p><code>${safeToken}</code></p><p>Expires: ${safeExpiry}</p><p>If you did not request this, you can ignore this email.</p>`,
  };
}

function resolveSesConfig(env = process.env) {
  const region = String(env.BEATGALER_SES_REGION || env.AWS_REGION || env.AWS_DEFAULT_REGION || '').trim();
  const fromEmail = String(env.BEATGALER_SES_FROM_EMAIL || '').trim();
  return { region, fromEmail };
}

function defaultAwsCredentialsProvider(region) {
  let client = null;
  return async () => {
    if (!client) {
      const { SecretsManagerClient } = require('@aws-sdk/client-secrets-manager');
      client = new SecretsManagerClient({ region });
    }
    const source = client.config.credentials;
    return typeof source === 'function' ? source() : source;
  };
}

function signedSesRequest({ region, fromEmail, to, content, credentials, now = new Date() }) {
  const accessKeyId = String(credentials?.accessKeyId || '');
  const secretAccessKey = String(credentials?.secretAccessKey || '');
  const sessionToken = String(credentials?.sessionToken || '');
  if (!accessKeyId || !secretAccessKey) {
    const error = new Error('AWS credentials are unavailable for SES.');
    error.code = 'SES_AWS_CREDENTIALS_REQUIRED';
    throw error;
  }

  const body = JSON.stringify({
    FromEmailAddress: fromEmail,
    Destination: { ToAddresses: [to] },
    Content: {
      Simple: {
        Subject: { Data: content.subject, Charset: 'UTF-8' },
        Body: {
          Text: { Data: content.text, Charset: 'UTF-8' },
          Html: { Data: content.html, Charset: 'UTF-8' },
        },
      },
    },
    EmailTags: [{ Name: 'beatgaler_template', Value: content.template_name }],
  });
  const hostname = `email.${region}.amazonaws.com`;
  const dateTime = amzDate(now);
  const dateStamp = dateTime.slice(0, 8);
  const payloadHash = sha256(body);
  const headers = {
    'content-type': 'application/json',
    host: hostname,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': dateTime,
  };
  if (sessionToken) headers['x-amz-security-token'] = sessionToken;

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map(name => `${name}:${String(headers[name]).trim()}\n`).join('');
  const signedHeaders = signedHeaderNames.join(';');
  const canonicalRequest = [
    'POST',
    SES_API_PATH,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const scope = `${dateStamp}/${region}/${SES_SERVICE}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    dateTime,
    scope,
    sha256(canonicalRequest),
  ].join('\n');
  const dateKey = hmac(Buffer.from(`AWS4${secretAccessKey}`, 'utf8'), dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, SES_SERVICE);
  const signingKey = hmac(serviceKey, 'aws4_request');
  const signature = hmac(signingKey, stringToSign, 'hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const requestHeaders = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    Host: hostname,
    'X-Amz-Content-Sha256': payloadHash,
    'X-Amz-Date': dateTime,
    Authorization: authorization,
  };
  if (sessionToken) requestHeaders['X-Amz-Security-Token'] = sessionToken;
  return {
    hostname,
    path: SES_API_PATH,
    method: 'POST',
    headers: requestHeaders,
    body,
    template_name: content.template_name,
  };
}

function sendHttps(requestImpl, input) {
  return new Promise((resolve, reject) => {
    const request = requestImpl({
      hostname: input.hostname,
      path: input.path,
      method: input.method,
      headers: input.headers,
      timeout: 10000,
    }, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size <= 256 * 1024) chunks.push(chunk);
      });
      response.on('end', () => {
        const status = Number(response.statusCode || 0);
        if (status >= 200 && status < 300) return resolve({ ok: true, status });
        const error = new Error(`Amazon SES rejected the account email request (${status || 'unknown'}).`);
        error.code = 'SES_SEND_FAILED';
        error.statusCode = status || 503;
        reject(error);
      });
    });
    request.on('timeout', () => request.destroy(Object.assign(new Error('Amazon SES request timed out.'), { code: 'SES_TIMEOUT' })));
    request.on('error', reject);
    request.write(input.body);
    request.end();
  });
}

function createSesEmailNotifier({
  env = process.env,
  credentialsProvider = null,
  requestImpl = https.request,
  now = () => new Date(),
} = {}) {
  const { region, fromEmail } = resolveSesConfig(env);
  if (!region || !fromEmail) {
    if (String(env.NODE_ENV || '') === 'production') {
      const error = new Error('Production account email requires BEATGALER_SES_REGION and BEATGALER_SES_FROM_EMAIL.');
      error.code = 'SES_CONFIG_REQUIRED';
      throw error;
    }
    return null;
  }
  const loadCredentials = credentialsProvider || defaultAwsCredentialsProvider(region);
  return async ({ kind, to, token, expires_at: expiresAt }) => {
    const target = String(to || '').trim();
    if (!target) {
      const error = new Error('SES account email destination is required.');
      error.code = 'SES_DESTINATION_REQUIRED';
      throw error;
    }
    const content = renderAccountEmail(kind, token, expiresAt);
    const credentials = await loadCredentials();
    const signed = signedSesRequest({
      region,
      fromEmail,
      to: target,
      content,
      credentials,
      now: now(),
    });
    await sendHttps(requestImpl, signed);
    return { delivered: true, provider: 'amazon_ses', template: content.template_name };
  };
}

module.exports = {
  EMAIL_TEMPLATES,
  renderAccountEmail,
  resolveSesConfig,
  signedSesRequest,
  createSesEmailNotifier,
};
