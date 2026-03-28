const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createApp,
  createRateLimiter,
  createWorkflowRepository,
  validateWorkflow,
} = require('../backend/server');

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

function buildTestApp({ baseUrl = 'http://localhost:8787', slug = 'abc123slug1' } = {}) {
  const pool = createMockPool();
  let counter = 0;
  const { app, repository } = createApp({
    pool,
    baseUrl,
    logger: false,
    nanoid: () => {
      counter += 1;
      if (counter === 1) return slug;
      return `${slug}-${counter}`;
    },
  });
  return { app, repository };
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

test('repository ensureSchema executes without error', async () => {
  const pool = createMockPool();
  const repository = createWorkflowRepository({ pool, nanoid: () => 'slug123abcd' });
  await repository.ensureSchema();
  assert.ok(true);
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
