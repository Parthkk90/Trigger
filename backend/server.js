const Fastify = require('fastify');
const cors = require('@fastify/cors');
const { customAlphabet } = require('nanoid');
const { Pool } = require('pg');

const app = Fastify({ logger: true });
const nanoid = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 10);

const PORT = Number(process.env.PORT || 8787);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/flowlink';
const EXTENSION_INSTALL_URL = process.env.EXTENSION_INSTALL_URL || 'https://chromewebstore.google.com/';

const pool = new Pool({
  connectionString: DATABASE_URL,
});

// Initializes the minimal production-safe schema.
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      start_url TEXT,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_workflows_slug ON workflows(slug);
  `);
}

function validateWorkflow(workflow) {
  if (!workflow || typeof workflow !== 'object') return 'workflow must be an object';
  if (!workflow.id || typeof workflow.id !== 'string') return 'workflow.id is required';
  if (!Array.isArray(workflow.steps)) return 'workflow.steps must be an array';
  if (!workflow.name || typeof workflow.name !== 'string') return 'workflow.name is required';
  return null;
}

app.register(cors, {
  origin: true,
});

app.get('/health', async () => ({ ok: true }));

// Fetches one workflow by ID.
async function getWorkflowById(id) {
  const result = await pool.query(
    `SELECT id, slug, data, created_at, updated_at FROM workflows WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

// Fetches one workflow by share slug.
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

  let slug = nanoid();
  while (true) {
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
        slug = nanoid();
        continue;
      }
      throw err;
    }
  }
}

// Create workflow and share slug.
app.post('/api/workflows', async (request, reply) => {
  const workflow = request.body;
  const error = validateWorkflow(workflow);
  if (error) return reply.code(400).send({ error });

  const saved = await upsertWorkflow(workflow);

  return {
    workflowId: saved.id,
    slug: saved.slug,
    shareUrl: `${BASE_URL}/l/${saved.slug}`,
  };
});

app.get('/api/workflows/:id', async (request, reply) => {
  const row = await getWorkflowById(request.params.id);
  if (!row) return reply.code(404).send({ error: 'workflow not found' });
  return row.data;
});

app.get('/api/links/:slug', async (request, reply) => {
  const row = await getWorkflowBySlug(request.params.slug);
  if (!row) return reply.code(404).send({ error: 'link not found' });
  return {
    slug: row.slug,
    workflow: row.data,
  };
});

// Slug resolver page.
app.get('/l/:slug', async (request, reply) => {
  const slug = request.params.slug;
  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
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
      <a class="btn" href="${EXTENSION_INSTALL_URL}" target="_blank" rel="noreferrer">Install FlowLink Extension</a>
      <a class="btn secondary" href="/api/links/${slug}" target="_blank" rel="noreferrer">View Workflow JSON</a>
    </div>
  </div>

  <script>
    const slug = ${JSON.stringify(slug)};
    const statusEl = document.getElementById('status');
    const extensionReadyEl = document.getElementById('extensionReady');
    const installPromptEl = document.getElementById('installPrompt');
    const runBtn = document.getElementById('runBtn');

    let hasExtension = false;

    // Detects extension by asking content script to answer a page-level ping.
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
        hasExtension = await detectExtension(1500);
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
  reply.type('text/html').send(html);
});

ensureSchema()
  .then(() => app.listen({ port: PORT, host: '0.0.0.0' }))
  .then(() => app.log.info(`FlowLink backend running on ${BASE_URL}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
