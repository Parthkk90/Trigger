import Fastify from 'fastify';
import cors from '@fastify/cors';
import { customAlphabet } from 'nanoid';
import { Pool } from 'pg';
import { fileURLToPath } from 'url';
import {
  runMigrations,
  verifyMigrationPreflight,
} from './migration-runner.js';
import { createCloudReplayService } from './cloud-replay.js';

const DEFAULT_PORT = Number(process.env.PORT || 8787);
const DEFAULT_BASE_URL = process.env.BASE_URL || `http://localhost:${DEFAULT_PORT}`;
const DEFAULT_DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/flowlink';
const DEFAULT_EXTENSION_INSTALL_URL =
  process.env.EXTENSION_INSTALL_URL || 'https://chromewebstore.google.com/';

export function validateWorkflow(workflow) {
  if (!workflow || typeof workflow !== 'object') return 'workflow must be an object';
  if (!workflow.id || typeof workflow.id !== 'string') return 'workflow.id is required';
  if (!Array.isArray(workflow.steps)) return 'workflow.steps must be an array';
  if (!workflow.name || typeof workflow.name !== 'string') return 'workflow.name is required';
  return null;
}

export function createRateLimiter() {
  const store = new Map();
  const windowMs = 60 * 1000;
  const maxRequests = 100;

  // Per-IP in-memory limiter for share endpoint hardening.
  return function checkRateLimit(ip) {
    const now = Date.now();
    const key = ip || 'unknown';
    const record = store.get(key) || { count: 0, resetAt: now + windowMs };

    if (now > record.resetAt) {
      record.count = 0;
      record.resetAt = now + windowMs;
    }

    record.count += 1;
    store.set(key, record);

    return {
      allowed: record.count <= maxRequests,
      limit: maxRequests,
      remaining: Math.max(0, maxRequests - record.count),
      resetAt: record.resetAt,
      windowMs,
    };
  };
}

export function createWorkflowRepository({ pool, nanoid }) {
  async function getWorkflowById(id) {
    const result = await pool.query(
      `SELECT id, slug, data, created_at, updated_at FROM workflows WHERE id = $1`,
      [id]
    );
    return result.rows[0] || null;
  }

  async function getWorkflowBySlug(slug) {
    const result = await pool.query(
      `SELECT id, slug, data, created_at, updated_at FROM workflows WHERE slug = $1`,
      [slug]
    );
    return result.rows[0] || null;
  }

  // Creates or updates a workflow while preserving existing slug on update.
  async function upsertWorkflow(workflow) {
    const existing = await getWorkflowById(workflow.id);
    const nowIso = new Date().toISOString();
    const startUrl = workflow.startUrl || null;
    const name = workflow.name;
    const data = {
      ...workflow,
      createdAt: workflow.createdAt || Date.now(),
      updatedAt: Date.now(),
    };

    if (existing) {
      const updated = await pool.query(
        `
        UPDATE workflows
        SET name = $2, start_url = $3, data = $4::jsonb, updated_at = $5
        WHERE id = $1
        RETURNING id, slug
        `,
        [workflow.id, name, startUrl, JSON.stringify(data), nowIso]
      );
      return updated.rows[0];
    }

    const maxSlugRetries = 10;
    let slug = nanoid();
    let collisions = 0;

    while (collisions <= maxSlugRetries) {
      try {
        const inserted = await pool.query(
          `
          INSERT INTO workflows (id, slug, name, start_url, data, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
          RETURNING id, slug
          `,
          [workflow.id, slug, name, startUrl, JSON.stringify(data), nowIso, nowIso]
        );
        return inserted.rows[0];
      } catch (err) {
        if (err.code === '23505') {
          collisions += 1;
          if (collisions > maxSlugRetries) {
            const exhausted = new Error('slug_generation_exhausted');
            exhausted.code = 'SLUG_GENERATION_EXHAUSTED';
            throw exhausted;
          }
          slug = nanoid();
          continue;
        }
        throw err;
      }
    }
  }

  return {
    getWorkflowById,
    getWorkflowBySlug,
    upsertWorkflow,
  };
}

export function createSlugResolverHtml({ slug, extensionInstallUrl, cspConnectOrigin }) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ${cspConnectOrigin};">
  <title>FlowLink Replay</title>
  <style>
    body { font-family: sans-serif; margin: 0; padding: 24px; background: #f7fafc; color: #1f2937; }
    .card { max-width: 680px; margin: 0 auto; background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 20px; }
    .btn { display: inline-block; margin-top: 12px; margin-right: 8px; padding: 10px 14px; background: #2563eb; color: #fff; text-decoration: none; border-radius: 8px; border: none; cursor: pointer; }
    .btn.secondary { background: #374151; }
    .hint { color: #4b5563; font-size: 14px; }
    .hidden { display: none; }
    code { background: #f3f4f6; padding: 2px 6px; border-radius: 4px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>FlowLink Workflow</h1>
    <p>Link slug: <code>${slug}</code></p>
    <p class="hint" id="status">Checking FlowLink extension...</p>

    <div id="extensionReady" class="hidden">
      <button class="btn" id="runBtn">Replay In This Tab</button>
      <a class="btn secondary" href="/api/links/${slug}" target="_blank" rel="noreferrer">View Workflow JSON</a>
    </div>

    <div id="installPrompt" class="hidden">
      <p class="hint">FlowLink extension is not detected in this browser.</p>
      <a class="btn" href="${extensionInstallUrl}" target="_blank" rel="noreferrer">Install FlowLink Extension</a>
      <a class="btn secondary" href="/api/links/${slug}" target="_blank" rel="noreferrer">View Workflow JSON</a>
    </div>
  </div>

  <script>
    const slug = ${JSON.stringify(slug)};
    const statusEl = document.getElementById('status');
    const extensionReadyEl = document.getElementById('extensionReady');
    const installPromptEl = document.getElementById('installPrompt');
    const runBtn = document.getElementById('runBtn');

    function detectExtension(timeoutMs) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          window.removeEventListener('message', onMessage);
          resolve(false);
        }, timeoutMs);

        function onMessage(event) {
          if (event.source !== window) return;
          const data = event.data || {};
          if (data.type === 'FLOWLINK_PONG') {
            clearTimeout(timer);
            window.removeEventListener('message', onMessage);
            resolve(true);
          }
        }

        window.addEventListener('message', onMessage);
        window.postMessage({ type: 'FLOWLINK_PING' }, '*');
      });
    }

    async function loadWorkflowBySlug() {
      const response = await fetch('/api/links/' + encodeURIComponent(slug));
      if (!response.ok) {
        throw new Error('Failed to load workflow: ' + response.status);
      }
      const payload = await response.json();
      return payload.workflow;
    }

    async function start() {
      try {
        const hasExtension = await detectExtension(1500);
        if (hasExtension) {
          statusEl.textContent = 'Extension detected. Ready to replay.';
          extensionReadyEl.classList.remove('hidden');
          return;
        }

        statusEl.textContent = 'Extension not detected.';
        installPromptEl.classList.remove('hidden');
      } catch (err) {
        statusEl.textContent = 'Unable to initialize replay page.';
        installPromptEl.classList.remove('hidden');
      }
    }

    runBtn.addEventListener('click', async () => {
      statusEl.textContent = 'Loading workflow...';
      try {
        const workflow = await loadWorkflowBySlug();
        window.postMessage({ type: 'FLOWLINK_REPLAY', workflow }, '*');
        statusEl.textContent = 'Replay command sent to extension.';
      } catch (err) {
        statusEl.textContent = err.message;
      }
    });

    start();
  </script>
</body>
</html>`;
}

export function createApp(options = {}) {
  const port = Number(options.port || DEFAULT_PORT);
  const baseUrl = options.baseUrl || DEFAULT_BASE_URL;
  const databaseUrl = options.databaseUrl || DEFAULT_DATABASE_URL;
  const extensionInstallUrl = options.extensionInstallUrl || DEFAULT_EXTENSION_INSTALL_URL;
  const apiToken = options.apiToken !== undefined ? options.apiToken : process.env.TRIGGER_API_TOKEN;
  const logger = options.logger !== undefined ? options.logger : true;

  const app = Fastify({ logger });
  const pool =
    options.pool ||
    new Pool({
      connectionString: databaseUrl,
    });

  const nanoid = options.nanoid || customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 10);
  const repository = createWorkflowRepository({ pool, nanoid });
  const checkRateLimit = createRateLimiter();
  const cspConnectOrigin = new URL(baseUrl).origin;
  const cloudReplayService =
    options.cloudReplayService ||
    createCloudReplayService({
      redisUrl: process.env.REDIS_URL,
      queueName: 'cloud-replay',
    });

  app.register(cors, {
    origin: true,
  });

  app.addHook('onRequest', async (request, reply) => {
    if (!apiToken) return;
    if (request.method !== 'POST') return;

    const header = request.headers.authorization || '';
    const expected = `Bearer ${apiToken}`;
    if (header !== expected) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.get('/', async () => ({
    service: 'flowlink-backend',
    ok: true,
    endpoints: {
      health: '/health',
      createWorkflow: '/api/workflows',
      getWorkflow: '/api/workflows/:id',
      getLink: '/api/links/:slug',
      replayPage: '/l/:slug',
    },
  }));

  app.get('/health', async () => ({ ok: true }));

  app.get('/api/capabilities', async () => ({
    cloudReplay: {
      enabled: !!(cloudReplayService && cloudReplayService.enabled),
    },
  }));

  app.post('/api/workflows', async (request, reply) => {
    const limit = checkRateLimit(request.ip);
    reply.header('X-RateLimit-Limit', String(limit.limit));
    reply.header('X-RateLimit-Remaining', String(limit.remaining));
    reply.header('X-RateLimit-Reset', String(Math.floor(limit.resetAt / 1000)));

    if (!limit.allowed) {
      const retryAfter = Math.max(1, Math.ceil((limit.resetAt - Date.now()) / 1000));
      reply.header('Retry-After', String(retryAfter));
      return reply.code(429).send({ error: 'rate limit exceeded' });
    }

    const workflow = request.body;
    const error = validateWorkflow(workflow);
    if (error) return reply.code(400).send({ error });

    let saved;
    try {
      saved = await repository.upsertWorkflow(workflow);
    } catch (err) {
      if (err && err.code === 'SLUG_GENERATION_EXHAUSTED') {
        return reply.code(500).send({ error: 'slug_generation_exhausted' });
      }
      throw err;
    }

    return {
      workflowId: saved.id,
      slug: saved.slug,
      shareUrl: `${baseUrl}/l/${saved.slug}`,
    };
  });

  app.get('/api/workflows/:id', async (request, reply) => {
    const row = await repository.getWorkflowById(request.params.id);
    if (!row) return reply.code(404).send({ error: 'workflow not found' });
    return row.data;
  });

  app.get('/api/links/:slug', async (request, reply) => {
    const row = await repository.getWorkflowBySlug(request.params.slug);
    if (!row) return reply.code(404).send({ error: 'link not found' });
    return {
      slug: row.slug,
      workflow: row.data,
    };
  });

  app.get('/l/:slug', async (request, reply) => {
    const slug = request.params.slug;
    const html = createSlugResolverHtml({
      slug,
      extensionInstallUrl,
      cspConnectOrigin,
    });
    reply.type('text/html').send(html);
  });

  app.post('/api/replay/cloud', async (request, reply) => {
    if (!cloudReplayService || !cloudReplayService.enabled) {
      return reply.code(503).send({ error: 'cloud_replay_unavailable' });
    }

    const workflowId = request.body && request.body.workflowId;
    const vault = (request.body && request.body.vault) || {};

    if (!workflowId || typeof workflowId !== 'string') {
      return reply.code(400).send({ error: 'workflowId is required' });
    }

    const row = await repository.getWorkflowById(workflowId);
    if (!row) {
      return reply.code(404).send({ error: 'workflow not found' });
    }

    const jobId = await cloudReplayService.enqueue({
      workflowId,
      workflow: row.data,
      vault,
    });

    return { jobId };
  });

  app.get('/api/replay/cloud/:jobId', async (request, reply) => {
    if (!cloudReplayService || !cloudReplayService.enabled) {
      return reply.code(503).send({ error: 'cloud_replay_unavailable' });
    }

    const status = await cloudReplayService.getStatus(String(request.params.jobId));
    if (!status) {
      return reply.code(404).send({ error: 'job not found' });
    }

    return status;
  });

  // Alias for common "l" vs "1" confusion in copied share links.
  app.get('/1/:slug', async (request, reply) => {
    const slug = request.params.slug;
    reply.redirect(`/l/${encodeURIComponent(slug)}`, 302);
  });

  app.addHook('onClose', async () => {
    if (cloudReplayService && typeof cloudReplayService.close === 'function') {
      await cloudReplayService.close();
    }
  });

  return {
    app,
    pool,
    repository,
    cloudReplayService,
    checkRateLimit,
    validateWorkflow,
  };
}

export async function startServer() {
  const { app, pool } = createApp();
  verifyMigrationPreflight();
  await runMigrations({ pool });
  const host = '0.0.0.0';
  await app.listen({ port: DEFAULT_PORT, host });
  app.log.info(`FlowLink backend running on ${DEFAULT_BASE_URL}`);
}

// ESM replacement for `if (require.main === module)`
const isMainModule = (process.argv[1] === fileURLToPath(import.meta.url));
if (isMainModule) {
  startServer().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}