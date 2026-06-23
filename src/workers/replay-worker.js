import { Worker } from 'bullmq';
import playwright from 'playwright';

const QUEUE_NAME = 'cloud-replay';
const DEFAULT_CONCURRENCY = Number(process.env.PLAYWRIGHT_CONCURRENCY || 2);

const CONFIDENCE_AUTO = 85;
const CONFIDENCE_SHOW = 50;

function candidateFromTarget(target) {
  const out = [];
  if (!target || typeof target !== 'object') return out;

  if (target.ariaLabel) out.push({ kind: 'ariaLabel', value: target.ariaLabel, confidence: 90 });
  if (target.name) out.push({ kind: 'name', value: target.name, confidence: 80 });
  if (target.placeholder) out.push({ kind: 'placeholder', value: target.placeholder, confidence: 70 });
  if (target.text) out.push({ kind: 'text', value: target.text, confidence: 75 });
  if (target.selector) out.push({ kind: 'selector', value: target.selector, confidence: 65 });

  return out;
}

async function resolvePlaywrightLocator(page, step) {
  const candidates = candidateFromTarget(step.target);

  for (const candidate of candidates) {
    let locator;
    if (candidate.kind === 'selector') locator = page.locator(candidate.value).first();
    else if (candidate.kind === 'ariaLabel') locator = page.getByLabel(candidate.value).first();
    else if (candidate.kind === 'name') locator = page.locator(`[name="${candidate.value}"]`).first();
    else if (candidate.kind === 'placeholder') locator = page.getByPlaceholder(candidate.value).first();
    else if (candidate.kind === 'text') locator = page.getByText(candidate.value, { exact: false }).first();

    if (!locator) continue;

    try {
      const count = await locator.count();
      if (count > 0) {
        return { locator, confidence: candidate.confidence, match: candidate.kind };
      }
    } catch (err) {
      // Ignore locator resolution errors and try next candidate.
    }
  }

  return { locator: null, confidence: 0, match: 'none' };
}

function deriveCredentialKey(step) {
  const target = step && step.target ? step.target : {};
  const base = target.name || target.ariaLabel || target.placeholder || target.text || `field_${step.index}`;
  return String(base || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || `field_${step.index}`;
}

async function executeStepOnPage(page, step, vault = {}) {
  if (step.type === 'navigate') {
    await page.goto(step.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return { success: true, confidence: 100, match: 'navigate' };
  }

  const resolved = await resolvePlaywrightLocator(page, step);
  if (!resolved.locator || resolved.confidence < CONFIDENCE_SHOW) {
    return {
      success: false,
      confidence: resolved.confidence,
      reason: 'selector_not_found',
      reasonType: 'selector_not_found',
    };
  }

  if (step.type === 'click') {
    await resolved.locator.click();
  } else if (step.type === 'input') {
    let value = String(step.value || '');
    if (step.sensitive) {
      const vaultKey = deriveCredentialKey(step);
      value = vault[vaultKey] || '';
    }
    await resolved.locator.fill(value);
  } else if (step.type === 'select') {
    await resolved.locator.selectOption(String(step.value || ''));
  } else if (step.type === 'check') {
    if (step.checked) await resolved.locator.check();
    else await resolved.locator.uncheck();
  } else if (step.type === 'keypress') {
    await page.keyboard.press(String(step.key || 'Enter'));
  } else {
    return {
      success: false,
      confidence: 0,
      reason: 'action_error',
      reasonType: 'action_error',
    };
  }

  return {
    success: true,
    confidence: resolved.confidence,
    mode: resolved.confidence >= CONFIDENCE_AUTO ? 'auto' : 'assisted',
    match: resolved.match,
  };
}

async function processCloudReplayJob(job, options = {}) {
  const playwrightModule = options.playwrightModule || playwright;

  const workflow = job.data && job.data.workflow;
  const vault = (job.data && job.data.vault) || {};

  if (!workflow || !Array.isArray(workflow.steps)) {
    throw new Error('invalid_workflow_payload');
  }

  const browser = await playwrightModule.chromium.launch({ headless: true });
  const page = await browser.newPage();

  const stepResults = [];
  const startedAt = Date.now();

  try {
    for (let i = 0; i < workflow.steps.length; i += 1) {
      const step = workflow.steps[i];
      const result = await executeStepOnPage(page, step, vault);

      const screenshotBuffer = await page.screenshot({ fullPage: true });
      const screenshot = screenshotBuffer.toString('base64');

      const entry = {
        index: i,
        type: step.type,
        success: !!result.success,
        confidence: result.confidence,
        mode: result.mode || null,
        match: result.match || null,
        reason: result.reason || null,
        reasonType: result.reasonType || null,
        screenshot,
      };
      stepResults.push(entry);

      await job.updateProgress({
        index: i,
        total: workflow.steps.length,
        status: 'running',
      });

      if (!result.success) {
        const error = new Error('cloud_replay_step_failed');
        error.details = {
          status: 'failed',
          failedAtStep: i,
          steps: stepResults,
          workflowId: workflow.id,
          reason: result.reason,
          reasonType: result.reasonType,
        };
        throw error;
      }
    }

    const completed = {
      status: 'completed',
      workflowId: workflow.id,
      startedAt,
      finishedAt: Date.now(),
      steps: stepResults,
    };

    return completed;
  } catch (err) {
    if (err.details) {
      throw err;
    }

    const wrapped = new Error(err.message || 'cloud_replay_failed');
    wrapped.details = {
      status: 'failed',
      workflowId: workflow.id,
      startedAt,
      finishedAt: Date.now(),
      steps: stepResults,
      reason: err.message || 'unknown_error',
    };
    throw wrapped;
  } finally {
    await browser.close();
  }
}

export async function startReplayWorker(options = {}) {
  const redisUrl = options.redisUrl || process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error('REDIS_URL is required for cloud replay worker');
  }

  const WorkerClass = options.WorkerClass || Worker;
  const processJob = options.processJob || processCloudReplayJob;

  const worker = new WorkerClass(
    QUEUE_NAME,
    async (job) => {
      try {
        return await processJob(job);
      } catch (err) {
        if (err.details) {
          throw new Error(JSON.stringify(err.details));
        }
        throw err;
      }
    },
    {
      connection: { url: redisUrl },
      concurrency: Number.isFinite(DEFAULT_CONCURRENCY) && DEFAULT_CONCURRENCY > 0 ? DEFAULT_CONCURRENCY : 2,
    }
  );

  worker.on('completed', (job) => {
    console.log('[cloud-replay-worker] completed job', job.id);
  });

  worker.on('failed', (job, err) => {
    console.error('[cloud-replay-worker] failed job', job && job.id, err && err.message);
  });

  console.log('[cloud-replay-worker] started with concurrency', DEFAULT_CONCURRENCY);
  return worker;
}

export {
  CONFIDENCE_AUTO,
  CONFIDENCE_SHOW,
  executeStepOnPage,
  processCloudReplayJob,
};

import { fileURLToPath } from 'url';
const isMainModule = (process.argv[1] === fileURLToPath(import.meta.url));
if (isMainModule) {
  startReplayWorker().catch((err) => {
    console.error('[cloud-replay-worker] startup failed:', err.message);
    process.exit(1);
  });
}
