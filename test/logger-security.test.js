const test = require('node:test');
const assert = require('node:assert/strict');
const { Logger } = require('../utils/logger');

function createCaptureLogger() {
  const calls = [];
  const logger = Object.create(Logger.prototype);
  logger.component = 'Test';
  logger.winston = {
    info: (...args) => calls.push(['info', ...args]),
    warn: (...args) => calls.push(['warn', ...args]),
    error: (...args) => calls.push(['error', ...args]),
    debug: (...args) => calls.push(['debug', ...args])
  };
  return { logger, calls };
}

function withQuietConsole(callback) {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    callback();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

test('logger redacts nested credentials, authorization headers, tokens, and secret text', () => {
  const { logger, calls } = createCaptureLogger();
  const sentinel = 'test-secret-value';

  withQuietConsole(() => logger.info('provider request started', {
    request: {
      headers: { Authorization: `Bearer ${sentinel}` },
      body: { apiKey: sentinel, options: [{ refresh_token: sentinel }] }
    },
    response: { data: { access_token: sentinel, status: 'accepted' } },
    diagnostic: `Authorization: Bearer ${sentinel}; API_KEY=${sentinel}`
  }));

  const serialized = JSON.stringify(calls);
  assert.equal(serialized.includes(sentinel), false);
  assert.match(serialized, /\[REDACTED\]/);
  assert.match(serialized, /"status":"accepted"/);
  assert.match(serialized, /provider request started/);
});

test('error and provider context logging redacts sensitive fields while retaining diagnostics', () => {
  const { logger, calls } = createCaptureLogger();
  const sentinel = 'context-secret-value';
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  let consoleErrorOutput = '';
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = value => { consoleErrorOutput += String(value); };
  try {
    const error = new Error(`Provider failed with Authorization: Bearer ${sentinel}`);
    error.response = { config: { headers: { authorization: `Bearer ${sentinel}` } }, status: 503 };
    logger.error('provider request failed', error, { request: { client_secret: sentinel } });
    logger.logErrorWithContext(error, {
      operation: 'text generation',
      request: { headers: { authorization: `Bearer ${sentinel}` } },
      response: { status: 503, data: [{ token: sentinel, retryable: true }] }
    });
  } finally {
    console.log = originalLog;
    console.error = originalError;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  }

  const serialized = JSON.stringify(calls);
  assert.equal(serialized.includes(sentinel), false);
  assert.equal(consoleErrorOutput.includes(sentinel), false);
  assert.match(serialized, /"status":503/);
  assert.match(serialized, /text generation/);
  assert.match(serialized, /Provider failed with Authorization: \[REDACTED\]/);
});

test('ordinary logger messages and non-sensitive diagnostic data remain unchanged', () => {
  const { logger, calls } = createCaptureLogger();
  withQuietConsole(() => logger.info('generation completed', { jobId: 'job-42', durationMs: 1250 }));

  assert.deepEqual(calls, [['info', 'generation completed', { jobId: 'job-42', durationMs: 1250 }]]);
});
