import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import {
  createApp,
  createRateLimiter,
  createWorkflowRepository,
  validateWorkflow,
} from '../src/backend/server.js';
import { runMigrations, rollbackMigration } from '../src/backend/migration-runner.js';
import { processCloudReplayJob, startReplayWorker } from '../src/workers/replay-worker.js';

function createMockPool() {
  const byId = new Map();
  const bySlug = new Map();

  function rowFor(record) {
    if (!record) return null;
    return {
      id: record.id,
      slug: record.slug,
      data: record.data,
      created_at: record.created_at,
      updated_at: record.updated_at,
    };
  }

  return {
    async query(sql, params = []) {
      const q = sql.replace(/\s+/g, ' ').trim();

      if (q.startsWith('CREATE TABLE') || q.startsWith('CREATE INDEX')) {
        return { rows: [] };
      }

      if (q.includes('SELECT id, slug, data, created_at, updated_at FROM workflows WHERE id = $1')) {
        const record = byId.get(params[0]);
        return { rows: record ? [rowFor(record)] : [] };
      }

      if (q.includes('SELECT id, slug, data, created_at, updated_at FROM workflows WHERE slug = $1')) {
        const id = bySlug.get(params[0]);
        const record = id ? byId.get(id) : null;
        return { rows: record ? [rowFor(record)] : [] };
      }

      if (q.startsWith('UPDATE workflows')) {
        const [id, name, startUrl, dataJson, updatedAt] = params;
        const record = byId.get(id);
        if (!record) return { rows: [] };
        record.name = name;
        record.start_url = startUrl;
        record.data = JSON.parse(dataJson);
        record.updated_at = updatedAt;
        byId.set(id, record);
        return { rows: [{ id: record.id, slug: record.slug }] };
      }

      if (q.startsWith('INSERT INTO workflows')) {
        const [id, slug, name, startUrl, dataJson, createdAt, updatedAt] = params;
        if (byId.has(id) || bySlug.has(slug)) {
          const err = new Error('duplicate key value violates unique constraint');
          err.code = '23505';
          throw err;
        }

        const record = {
          id,
          slug,
          name,
          start_url: startUrl,
          data: JSON.parse(dataJson),
          created_at: createdAt,
          updated_at: updatedAt,
        };
        byId.set(id, record);
        bySlug.set(slug, id);
        return { rows: [{ id, slug }] };
      }

      throw new Error(`Unhandled query in mock pool: ${q}`);
    },
  };
}

function createTestWorkflow(overrides = {}) {
  return {
    id: overrides.id || 'wf-1',
    name: overrides.name || 'Workflow Demo',
    startUrl: overrides.startUrl || 'https://example.com/login',
    steps: overrides.steps || [{ type: 'navigate', url: 'https://example.com/login' }],
    createdAt: overrides.createdAt || Date.now(),
  };
}

function buildTestApp({
  baseUrl = 'http://localhost:8787',
  slug = 'abc123slug1',
  apiToken,
  nanoidFactory,
  cloudReplayService,
} = {}) {
  const pool = createMockPool();
  let counter = 0;
  const { app, repository } = createApp({
    pool,
    baseUrl,
    logger: false,
    apiToken,
    cloudReplayService,
    nanoid: nanoidFactory || (() => {
      counter += 1;
      if (counter === 1) return slug;
      return `${slug}-${counter}`;
    }),
  });
  return { app, repository };
}

function createMigrationPoolMock(appliedNames = []) {
  const applied = new Set(appliedNames);
  const executedSql = [];

  const pool = {
    executedSql,
    applied,
    async query(sql, params = []) {
      const q = sql.replace(/\s+/g, ' ').trim();

      if (q.startsWith('CREATE TABLE IF NOT EXISTS schema_migrations')) {
        return { rows: [] };
      }

      if (q === 'SELECT name FROM schema_migrations') {
        return { rows: Array.from(applied).map((name) => ({ name })) };
      }

      if (q.startsWith('SELECT name FROM schema_migrations ORDER BY applied_at DESC, name DESC LIMIT 1')) {
        const names = Array.from(applied).sort().reverse();
        return { rows: names.length ? [{ name: names[0] }] : [] };
      }

      if (q.startsWith('INSERT INTO schema_migrations (name) VALUES ($1)')) {
        applied.add(params[0]);
        return { rows: [] };
      }

      if (q.startsWith('DELETE FROM schema_migrations WHERE name = $1')) {
        applied.delete(params[0]);
        return { rows: [] };
      }

      executedSql.push(q);
      return { rows: [] };
    },
    async connect() {
      return {
        async query(sql, params) {
          return pool.query(sql, params);
        },
        release() {},
      };
    },
  };

  return pool;
}

test('validateWorkflow rejects non-object payload', () => {
  assert.equal(validateWorkflow(null), 'workflow must be an object');
});

test('validateWorkflow requires id', () => {
  assert.equal(validateWorkflow({ name: 'x', steps: [] }), 'workflow.id is required');
});

test('validateWorkflow requires steps array', () => {
  assert.equal(validateWorkflow({ id: 'x', name: 'x', steps: 'bad' }), 'workflow.steps must be an array');
});

test('validateWorkflow requires name', () => {
  assert.equal(validateWorkflow({ id: 'x', steps: [] }), 'workflow.name is required');
});

test('validateWorkflow accepts valid workflow', () => {
  assert.equal(validateWorkflow(createTestWorkflow()), null);
});

test('createRateLimiter allows up to 100 requests', () => {
  const limiter = createRateLimiter();
  let result;
  for (let i = 0; i < 100; i += 1) result = limiter('127.0.0.1');
  assert.equal(result.allowed, true);
  assert.equal(result.remaining, 0);
});

test('createRateLimiter blocks request 101', () => {
  const limiter = createRateLimiter();
  for (let i = 0; i < 100; i += 1) limiter('127.0.0.1');
  const result = limiter('127.0.0.1');
  assert.equal(result.allowed, false);
});

test('repository upsert inserts workflow', async () => {
  const pool = createMockPool();
  const repository = createWorkflowRepository({ pool, nanoid: () => 'sluginsert1' });
  const saved = await repository.upsertWorkflow(createTestWorkflow());
  assert.equal(saved.id, 'wf-1');
  assert.equal(saved.slug, 'sluginsert1');
});

test('repository upsert preserves slug on update', async () => {
  const pool = createMockPool();
  const repository = createWorkflowRepository({ pool, nanoid: () => 'slugfixed01' });
  await repository.upsertWorkflow(createTestWorkflow({ id: 'wf-upsert' }));
  const updated = await repository.upsertWorkflow(
    createTestWorkflow({ id: 'wf-upsert', name: 'Updated Name' })
  );
  assert.equal(updated.slug, 'slugfixed01');
});

test('repository getWorkflowBySlug returns inserted workflow', async () => {
  const pool = createMockPool();
  const repository = createWorkflowRepository({ pool, nanoid: () => 'slugbyref01' });
  await repository.upsertWorkflow(createTestWorkflow({ id: 'wf-lookup' }));
  const row = await repository.getWorkflowBySlug('slugbyref01');
  assert.equal(row.id, 'wf-lookup');
});

test('GET /health returns ok', async () => {
  const { app } = buildTestApp();
  const response = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { ok: true });
  await app.close();
});

test('POST /api/workflows creates workflow and share URL', async () => {
  const { app } = buildTestApp({ slug: 'slugshare01' });
  const response = await app.inject({
    method: 'POST',
    url: '/api/workflows',
    payload: createTestWorkflow({ id: 'wf-create' }),
  });

  assert.equal(response.statusCode, 200);
  const payload = response.json();
  assert.equal(payload.workflowId, 'wf-create');
  assert.equal(payload.slug, 'slugshare01');
  assert.equal(payload.shareUrl, 'http://localhost:8787/l/slugshare01');
  await app.close();
});

test('POST /api/workflows rejects invalid payload', async () => {
  const { app } = buildTestApp();
  const response = await app.inject({
    method: 'POST',
    url: '/api/workflows',
    payload: { id: 'bad' },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, 'workflow.steps must be an array');
  await app.close();
});

test('POST /api/workflows includes rate limit headers', async () => {
  const { app } = buildTestApp();
  const response = await app.inject({
    method: 'POST',
    url: '/api/workflows',
    payload: createTestWorkflow({ id: 'wf-ratelimit-headers' }),
  });

  assert.equal(response.statusCode, 200);
  assert.ok(response.headers['x-ratelimit-limit']);
  assert.ok(response.headers['x-ratelimit-remaining']);
  assert.ok(response.headers['x-ratelimit-reset']);
  await app.close();
});

test('POST /api/workflows returns 429 after 100 requests per IP', async () => {
  const { app } = buildTestApp();

  for (let i = 0; i < 100; i += 1) {
    const ok = await app.inject({
      method: 'POST',
      url: '/api/workflows',
      remoteAddress: '10.0.0.1',
      payload: createTestWorkflow({ id: `wf-rate-${i}` }),
    });
    assert.equal(ok.statusCode, 200);
  }

  const blocked = await app.inject({
    method: 'POST',
    url: '/api/workflows',
    remoteAddress: '10.0.0.1',
    payload: createTestWorkflow({ id: 'wf-rate-101' }),
  });

  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.json().error, 'rate limit exceeded');
  assert.ok(blocked.headers['retry-after']);
  await app.close();
});

test('GET /api/workflows/:id fetches stored workflow', async () => {
  const { app } = buildTestApp({ slug: 'slugfetchid1' });
  await app.inject({
    method: 'POST',
    url: '/api/workflows',
    payload: createTestWorkflow({ id: 'wf-get-id' }),
  });

  const response = await app.inject({ method: 'GET', url: '/api/workflows/wf-get-id' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().id, 'wf-get-id');
  await app.close();
});

test('GET /api/workflows/:id returns 404 for missing workflow', async () => {
  const { app } = buildTestApp();
  const response = await app.inject({ method: 'GET', url: '/api/workflows/not-found' });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error, 'workflow not found');
  await app.close();
});

test('GET /api/links/:slug returns workflow by slug', async () => {
  const { app } = buildTestApp({ slug: 'sluglookup01' });
  await app.inject({
    method: 'POST',
    url: '/api/workflows',
    payload: createTestWorkflow({ id: 'wf-slug' }),
  });

  const response = await app.inject({ method: 'GET', url: '/api/links/sluglookup01' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().slug, 'sluglookup01');
  assert.equal(response.json().workflow.id, 'wf-slug');
  await app.close();
});

test('GET /api/links/:slug returns 404 for missing slug', async () => {
  const { app } = buildTestApp();
  const response = await app.inject({ method: 'GET', url: '/api/links/missing-slug' });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error, 'link not found');
  await app.close();
});

test('GET /l/:slug renders HTML resolver page', async () => {
  const { app } = buildTestApp();
  const response = await app.inject({ method: 'GET', url: '/l/demo-slug' });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'], /text\/html/);
  assert.match(response.body, /FlowLink Workflow/);
  await app.close();
});

test('GET /l/:slug HTML includes CSP meta tag', async () => {
  const { app } = buildTestApp({ baseUrl: 'http://localhost:9999' });
  const response = await app.inject({ method: 'GET', url: '/l/demo-slug' });
  assert.match(response.body, /Content-Security-Policy/);
  assert.match(response.body, /connect-src 'self' http:\/\/localhost:9999/);
  await app.close();
});

test('GET /1/:slug redirects to /l/:slug', async () => {
  const { app } = buildTestApp();
  const response = await app.inject({ method: 'GET', url: '/1/demo-slug' });
  assert.equal(response.statusCode, 302);
  assert.equal(response.headers.location, '/l/demo-slug');
  await app.close();
});

test('POST /api/workflows upsert keeps slug for same id', async () => {
  const { app } = buildTestApp({ slug: 'slugstable01' });
  const first = await app.inject({
    method: 'POST',
    url: '/api/workflows',
    payload: createTestWorkflow({ id: 'wf-stable', name: 'Initial' }),
  });

  const second = await app.inject({
    method: 'POST',
    url: '/api/workflows',
    payload: createTestWorkflow({ id: 'wf-stable', name: 'Updated' }),
  });

  assert.equal(first.json().slug, 'slugstable01');
  assert.equal(second.json().slug, 'slugstable01');
  await app.close();
});

test('POST /api/workflows returns slug_generation_exhausted after capped collisions', async () => {
  const { app } = buildTestApp({
    slug: 'dupeslug01',
    nanoidFactory: () => 'dupeslug01',
  });

  const first = await app.inject({
    method: 'POST',
    url: '/api/workflows',
    payload: createTestWorkflow({ id: 'wf-dup-1' }),
  });
  assert.equal(first.statusCode, 200);

  const second = await app.inject({
    method: 'POST',
    url: '/api/workflows',
    payload: createTestWorkflow({ id: 'wf-dup-2' }),
  });

  assert.equal(second.statusCode, 500);
  assert.equal(second.json().error, 'slug_generation_exhausted');
  await app.close();
});

test('POST routes require bearer token when api token is configured', async () => {
  const { app } = buildTestApp({ apiToken: 'super-secret-token' });

  const unauthorized = await app.inject({
    method: 'POST',
    url: '/api/workflows',
    payload: createTestWorkflow({ id: 'wf-auth-1' }),
  });
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(unauthorized.json().error, 'unauthorized');

  const wrongToken = await app.inject({
    method: 'POST',
    url: '/api/workflows',
    headers: { Authorization: 'Bearer wrong-token' },
    payload: createTestWorkflow({ id: 'wf-auth-2' }),
  });
  assert.equal(wrongToken.statusCode, 401);

  const allowed = await app.inject({
    method: 'POST',
    url: '/api/workflows',
    headers: { Authorization: 'Bearer super-secret-token' },
    payload: createTestWorkflow({ id: 'wf-auth-3' }),
  });
  assert.equal(allowed.statusCode, 200);

  const publicGet = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(publicGet.statusCode, 200);

  await app.close();
});

test('runMigrations applies only pending SQL files in order', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trigger-migrations-'));
  fs.writeFileSync(
    path.join(dir, '001_first.sql'),
    'CREATE TABLE first_table (id INT);\n-- down\nDROP TABLE first_table;\n'
  );
  fs.writeFileSync(
    path.join(dir, '002_second.sql'),
    'CREATE TABLE second_table (id INT);\n-- down\nDROP TABLE second_table;\n'
  );

  const pool = createMigrationPoolMock(['001_first.sql']);
  const result = await runMigrations({
    pool,
    migrationsDir: dir,
    databaseUrl: 'postgres://postgres:postgres@localhost:5432/flowlink',
  });

  assert.deepEqual(result.applied, ['002_second.sql']);
  assert.equal(pool.applied.has('001_first.sql'), true);
  assert.equal(pool.applied.has('002_second.sql'), true);
  assert.equal(
    pool.executedSql.some((sql) => sql.includes('CREATE TABLE second_table')),
    true
  );
});

test('rollbackMigration rolls back most recent migration with down SQL', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trigger-rollback-'));
  fs.writeFileSync(
    path.join(dir, '001_first.sql'),
    'CREATE TABLE first_table (id INT);\n-- down\nDROP TABLE first_table;\n'
  );
  fs.writeFileSync(
    path.join(dir, '002_second.sql'),
    'CREATE TABLE second_table (id INT);\n-- down\nDROP TABLE second_table;\n'
  );

  const pool = createMigrationPoolMock(['001_first.sql', '002_second.sql']);
  const result = await rollbackMigration({
    pool,
    migrationsDir: dir,
    databaseUrl: 'postgres://postgres:postgres@localhost:5432/flowlink',
  });

  assert.equal(result.skipped, false);
  assert.equal(result.rolledBack, '002_second.sql');
  assert.equal(pool.applied.has('002_second.sql'), false);
  assert.equal(
    pool.executedSql.some((sql) => sql.includes('DROP TABLE second_table')),
    true
  );
});

test('rollbackMigration throws when down SQL is missing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trigger-rollback-missing-down-'));
  fs.writeFileSync(
    path.join(dir, '001_first.sql'),
    'CREATE TABLE first_table (id INT);\n'
  );

  const pool = createMigrationPoolMock(['001_first.sql']);
  await assert.rejects(
    () =>
      rollbackMigration({
        pool,
        migrationsDir: dir,
        databaseUrl: 'postgres://postgres:postgres@localhost:5432/flowlink',
      }),
    /down migration not defined/
  );
});

test('POST /api/replay/cloud returns 503 when cloud replay is unavailable', async () => {
  const cloudReplayService = {
    enabled: false,
    async close() {},
  };
  const { app } = buildTestApp({ cloudReplayService });

  const response = await app.inject({
    method: 'POST',
    url: '/api/replay/cloud',
    payload: { workflowId: 'wf-cloud-disabled' },
  });

  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error, 'cloud_replay_unavailable');
  await app.close();
});

test('POST /api/replay/cloud validates workflowId and queues workflow', async () => {
  let enqueuedPayload = null;
  const cloudReplayService = {
    enabled: true,
    async enqueue(payload) {
      enqueuedPayload = payload;
      return 'job-123';
    },
    async getStatus() {
      return null;
    },
    async close() {},
  };

  const { app } = buildTestApp({ cloudReplayService });

  const invalid = await app.inject({
    method: 'POST',
    url: '/api/replay/cloud',
    payload: {},
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error, 'workflowId is required');

  const missing = await app.inject({
    method: 'POST',
    url: '/api/replay/cloud',
    payload: { workflowId: 'wf-missing' },
  });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error, 'workflow not found');

  await app.inject({
    method: 'POST',
    url: '/api/workflows',
    payload: createTestWorkflow({ id: 'wf-cloud-ok' }),
  });

  const queued = await app.inject({
    method: 'POST',
    url: '/api/replay/cloud',
    payload: { workflowId: 'wf-cloud-ok' },
  });

  assert.equal(queued.statusCode, 200);
  assert.equal(queued.json().jobId, 'job-123');
  assert.equal(enqueuedPayload.workflowId, 'wf-cloud-ok');
  assert.equal(enqueuedPayload.workflow.id, 'wf-cloud-ok');

  await app.close();
});

test('GET /api/replay/cloud/:jobId returns status and 404 for missing jobs', async () => {
  const cloudReplayService = {
    enabled: true,
    async enqueue() {
      return 'unused';
    },
    async getStatus(jobId) {
      if (jobId === 'missing') return null;
      return {
        jobId,
        status: 'running',
        progress: { index: 1, total: 3, status: 'running' },
        failedReason: null,
        result: null,
      };
    },
    async close() {},
  };
  const { app } = buildTestApp({ cloudReplayService });

  const notFound = await app.inject({
    method: 'GET',
    url: '/api/replay/cloud/missing',
  });
  assert.equal(notFound.statusCode, 404);
  assert.equal(notFound.json().error, 'job not found');

  const found = await app.inject({
    method: 'GET',
    url: '/api/replay/cloud/job-555',
  });
  assert.equal(found.statusCode, 200);
  assert.equal(found.json().jobId, 'job-555');
  assert.equal(found.json().status, 'running');

  await app.close();
});

test('processCloudReplayJob returns completed status for valid workflow', async () => {
  class FakePage {
    async goto() {}
    async screenshot() {
      return Buffer.from('img');
    }
  }

  const job = {
    data: {
      workflow: {
        id: 'wf-worker-success',
        steps: [{ type: 'navigate', url: 'https://example.com' }],
      },
    },
    async updateProgress() {},
  };

  const playwrightModule = {
    chromium: {
      async launch() {
        return {
          async newPage() {
            return new FakePage();
          },
          async close() {},
        };
      },
    },
  };

  const result = await processCloudReplayJob(job, { playwrightModule });
  assert.equal(result.status, 'completed');
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].success, true);
});

test('processCloudReplayJob returns structured failure for invalid step action', async () => {
  class FakeLocator {
    async count() {
      return 1;
    }
  }

  class FakePage {
    locator() {
      return { first: () => new FakeLocator() };
    }
    getByLabel() {
      return { first: () => new FakeLocator() };
    }
    getByPlaceholder() {
      return { first: () => new FakeLocator() };
    }
    getByText() {
      return { first: () => new FakeLocator() };
    }
    async screenshot() {
      return Buffer.from('img');
    }
  }

  const job = {
    data: {
      workflow: {
        id: 'wf-worker-fail',
        steps: [
          {
            type: 'unsupported_action',
            target: { selector: '#submit' },
          },
        ],
      },
    },
    async updateProgress() {},
  };

  const playwrightModule = {
    chromium: {
      async launch() {
        return {
          async newPage() {
            return new FakePage();
          },
          async close() {},
        };
      },
    },
  };

  await assert.rejects(
    () => processCloudReplayJob(job, { playwrightModule }),
    (err) => {
      assert.equal(Boolean(err.details), true);
      assert.equal(err.details.status, 'failed');
      assert.equal(err.details.reasonType, 'action_error');
      return true;
    }
  );
});

test('startReplayWorker validates REDIS_URL and starts with injected worker class', async () => {
  await assert.rejects(
    () => startReplayWorker({ redisUrl: '' }),
    /REDIS_URL is required/
  );

  class FakeWorker {
    constructor(queueName, processor, options) {
      this.queueName = queueName;
      this.processor = processor;
      this.options = options;
      this.handlers = {};
    }

    on(event, handler) {
      this.handlers[event] = handler;
    }
  }

  const worker = await startReplayWorker({
    redisUrl: 'redis://localhost:6379',
    WorkerClass: FakeWorker,
    async processJob() {
      return { status: 'completed' };
    },
  });

  assert.equal(worker.queueName, 'cloud-replay');
  assert.equal(worker.options.connection.url, 'redis://localhost:6379');
  assert.equal(typeof worker.handlers.completed, 'function');
  assert.equal(typeof worker.handlers.failed, 'function');
});
