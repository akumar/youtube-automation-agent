const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { YouTubeAutomationAgent } = require('../index');
const { ProductionManagementAgent } = require('../agents/production-management-agent');
const { PublishingSchedulingAgent } = require('../agents/publishing-scheduling-agent');
const { DailyAutomation } = require('../schedules/daily-automation');
const { Database } = require('../database/db');

test('draft-only generation jobs are accepted without YouTube credentials', async () => {
  const agent = Object.create(YouTubeAutomationAgent.prototype);
  agent.draftOnlyMode = true;
  agent.setupRequired = false;
  agent.agents = { strategy: {} };
  agent.activeJobs = new Map();
  agent.validateGenerateRequestBody = () => ({ valid: true, value: { topic: 'Local draft', style: 'explainer', length: 'short' } });
  agent.db = { createGenerationJob: async input => ({ id: 'job-local', ...input }) };
  agent.runGenerationJob = async () => {};
  const job = await agent.startGenerationJob({ topic: 'Local draft', source: 'manual' });
  await Promise.all(agent.activeJobs.values());
  assert.equal(job.id, 'job-local');
  assert.equal(agent.activeJobs.size, 0);
});

test('draft-only approval persists review and revision-bound approval without scheduling', async () => {
  const agent = Object.create(YouTubeAutomationAgent.prototype);
  agent.draftOnlyMode = true;
  const bundle = {
    id: 'prod-local', status: 'ready', contentRevision: 'revision-1',
    script: { title: 'Local title' }, seo: {}, assets: {}, timeline: {}, provenance: {}
  };
  let localApproval;
  let scheduleAttempts = 0;
  agent.db = {
    getProductionBundle: async () => bundle,
    getChannelProfile: async () => ({}),
    approveContentLocally: async input => { localApproval = input; return { approval: { status: 'approved', contentRevision: 'revision-1' } }; }
  };
  agent.operator = {
    runQualityChecks: async () => ({ passed: true, checks: [], score: 100 }),
    notify: async () => {}
  };
  agent.agents = { publishing: { prepareScheduleEntry: async () => { scheduleAttempts++; } } };
  const result = await agent.approveContent('prod-local', { factChecked: true, rightsConfirmed: true });
  assert.equal(result.reviewStatus, 'approved');
  assert.equal(result.schedule, null);
  assert.equal(localApproval.expectedRevision, 'revision-1');
  assert.equal(scheduleAttempts, 0);
});

test('draft-only publishing agent rejects scheduling and publishing operations', async () => {
  const agent = new PublishingSchedulingAgent({}, {}, { draftOnly: true });
  await assert.rejects(agent.scheduleContent({ id: 'prod-local' }), error => error.code === 'DRAFT_ONLY_PUBLISHING_DISABLED');
  await assert.rejects(agent.publishContent('prod-local'), error => error.code === 'DRAFT_ONLY_PUBLISHING_DISABLED');
  await assert.rejects(agent.rescheduleContent('prod-local', new Date().toISOString()), error => error.code === 'DRAFT_ONLY_PUBLISHING_DISABLED');
  await assert.rejects(agent.emergencyPublish('prod-local', 30), error => error.code === 'DRAFT_ONLY_PUBLISHING_DISABLED');
  await assert.rejects(agent.pauseScheduledContent('prod-local'), error => error.code === 'DRAFT_ONLY_PUBLISHING_DISABLED');
  await assert.rejects(agent.resumeScheduledContent('prod-local'), error => error.code === 'DRAFT_ONLY_PUBLISHING_DISABLED');
  await assert.rejects(agent.processPublishQueue(), error => error.code === 'DRAFT_ONLY_PUBLISHING_DISABLED');
  await assert.rejects(agent.setupYouTubeAPI(), error => error.code === 'DRAFT_ONLY_PUBLISHING_DISABLED');
});

test('draft-only environment cannot be overridden by an explicit false option', async t => {
  const previous = process.env.YOUTUBE_AUTOMATION_DRAFT_ONLY;
  process.env.YOUTUBE_AUTOMATION_DRAFT_ONLY = 'true';
  t.after(() => {
    if (previous === undefined) delete process.env.YOUTUBE_AUTOMATION_DRAFT_ONLY;
    else process.env.YOUTUBE_AUTOMATION_DRAFT_ONLY = previous;
  });

  const agent = new PublishingSchedulingAgent({}, {}, { draftOnly: false });
  agent.logger = { info() {} };
  let authCalls = 0;
  agent.credentials = { getYouTubeAuth: () => { authCalls++; throw new Error('must not load YouTube auth'); } };
  await agent.initialize();
  assert.equal(agent.draftOnlyMode, true);
  assert.equal(agent.youtube, null);
  assert.deepEqual(agent.publishQueue, []);
  assert.equal(authCalls, 0);

  const productionAgent = new ProductionManagementAgent({}, {}, { draftOnly: false });
  assert.equal(productionAgent.draftOnlyMode, true);
  assert.equal(productionAgent.getScheduledPublishTime({ bestPublishTime: '2026-10-08T08:30:00.000Z' }), null);
});

test('draft-only API rejects direct schedule and publish requests', async t => {
  const previousKey = process.env.API_KEY;
  process.env.API_KEY = 'draft-only-test-key';
  const agent = Object.create(YouTubeAutomationAgent.prototype);
  agent.app = express();
  agent.logger = { warn() {} };
  agent.draftOnlyMode = true;
  agent.setupRequired = false;
  agent.validateGenerateRequestBody = () => ({ valid: true, value: { topic: 'Local draft', style: 'explainer', length: 'short' } });
  agent.startGenerationJob = async () => ({ id: 'job-api' });
  agent.setupAPI();
  const server = await new Promise(resolve => {
    const listening = agent.app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => {
    server.close();
    if (previousKey === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = previousKey;
  });
  const address = server.address();
  const request = (route, method = 'POST', body = '{}') => fetch(`http://127.0.0.1:${address.port}${route}`, {
    method, headers: { 'x-api-key': 'draft-only-test-key', 'content-type': 'application/json' }, body
  });
  const generation = await request('/generate');
  assert.equal(generation.status, 202, 'POST /generate should be accepted in draft-only mode');
  for (const [route, method] of [
    ['/api/content/prod/schedule', 'PATCH'],
    ['/api/content/prod/publish-now', 'POST'],
    ['/api/content/prod/schedule', 'DELETE'],
    ['/api/content/prod/shorts/clip/approve', 'POST'],
    ['/publish/prod', 'POST']
  ]) {
    const response = await request(route, method);
    assert.equal(response.status, 403, `${method} ${route} should be rejected`);
  }
});

test('mutating API authentication fails closed when API_KEY is missing or wrong', async t => {
  const previousKey = process.env.API_KEY;
  const agent = Object.create(YouTubeAutomationAgent.prototype);
  agent.app = express();
  agent.logger = { warn() {} };
  agent.draftOnlyMode = true;
  agent.setupRequired = false;
  agent.agents = {};
  agent.activeJobs = new Map();
  let publishCalls = 0;
  agent.db = { getProductionBundle: async () => ({ id: 'prod-local' }) };
  agent.agents.publishing = { publishContent: async () => { publishCalls++; } };
  agent.setupAPI();
  const server = await new Promise(resolve => {
    const listening = agent.app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    if (previousKey === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = previousKey;
  });

  const address = server.address();
  const request = key => fetch(`http://127.0.0.1:${address.port}/publish/prod-local`, {
    method: 'POST', headers: key === undefined ? {} : { 'x-api-key': key }
  });
  delete process.env.API_KEY;
  assert.equal((await request()).status, 503);
  process.env.API_KEY = 'expected-test-key';
  assert.equal((await request('wrong-test-key')).status, 401);
  assert.equal(publishCalls, 0);
});

test('uploadToYouTube remains unconditionally disabled', async () => {
  const agent = new PublishingSchedulingAgent({}, {});
  await assert.rejects(agent.uploadToYouTube({}), error => error.code === 'YOUTUBE_UPLOAD_DISABLED');
});

test('daily automation does not register a publishing queue task', async () => {
  const scheduler = new DailyAutomation({}, {});
  await scheduler.setupScheduledTasks();
  assert.equal(scheduler.scheduledTasks.has('publish-queue-processing'), false);
  await Promise.all([...scheduler.scheduledTasks.values()].map(task => task.destroy()));
});

test('draft-only publish metadata stays advisory and host defaults to loopback', async t => {
  const previousHost = process.env.HOST;
  const previousPort = process.env.PORT;
  const previousDraftMode = process.env.YOUTUBE_AUTOMATION_DRAFT_ONLY;
  delete process.env.HOST;
  process.env.PORT = '0';
  process.env.YOUTUBE_AUTOMATION_DRAFT_ONLY = 'true';
  t.after(() => {
    if (previousHost === undefined) delete process.env.HOST;
    else process.env.HOST = previousHost;
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
    if (previousDraftMode === undefined) delete process.env.YOUTUBE_AUTOMATION_DRAFT_ONLY;
    else process.env.YOUTUBE_AUTOMATION_DRAFT_ONLY = previousDraftMode;
  });

  const recommendedTime = '2026-10-08T08:30:00.000Z';
  const production = new ProductionManagementAgent({}, {});
  assert.equal(production.getScheduledPublishTime({ bestPublishTime: recommendedTime }), null);

  const agent = Object.create(YouTubeAutomationAgent.prototype);
  agent.initialize = async () => true;
  let listenedHost;
  agent.app = { listen: (_port, host, callback) => { listenedHost = host; callback(); return {}; } };
  const originalConsoleLog = console.log;
  console.log = () => {};
  try {
    await agent.start();
  } finally {
    console.log = originalConsoleLog;
  }
  assert.equal(listenedHost, '127.0.0.1');
});

test('database path override initializes only a temporary database and preserves the default path', async t => {
  const previousPath = process.env.YOUTUBE_AUTOMATION_DB_PATH;
  const previousLogDir = process.env.YOUTUBE_AUTOMATION_LOG_DIR;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'draft-only-db-'));
  const temporaryDatabasePath = path.join(tempDir, 'isolated.sqlite');
  process.env.YOUTUBE_AUTOMATION_DB_PATH = temporaryDatabasePath;
  process.env.YOUTUBE_AUTOMATION_LOG_DIR = path.join(tempDir, 'logs');
  const database = new Database();
  let defaultDatabase;
  t.after(async () => {
    await database.close();
    await new Promise(resolve => {
      database.logger.winston.once('finish', resolve);
      database.logger.winston.end();
    });
    if (defaultDatabase) {
      await new Promise(resolve => {
        defaultDatabase.logger.winston.once('finish', resolve);
        defaultDatabase.logger.winston.end();
      });
    }
    await fs.rm(tempDir, { recursive: true, force: true });
    if (previousPath === undefined) delete process.env.YOUTUBE_AUTOMATION_DB_PATH;
    else process.env.YOUTUBE_AUTOMATION_DB_PATH = previousPath;
    if (previousLogDir === undefined) delete process.env.YOUTUBE_AUTOMATION_LOG_DIR;
    else process.env.YOUTUBE_AUTOMATION_LOG_DIR = previousLogDir;
  });

  assert.equal(database.dbPath, temporaryDatabasePath);
  assert.equal(await database.initialize(), true);
  await database.close();
  database.db = null;
  await fs.access(temporaryDatabasePath);

  delete process.env.YOUTUBE_AUTOMATION_DB_PATH;
  defaultDatabase = new Database();
  assert.equal(defaultDatabase.dbPath, path.join(__dirname, '..', 'data', 'youtube_automation.db'));
});
