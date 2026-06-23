function mapBullStateToStatus(state) {
  if (state === 'completed') return 'completed';
  if (state === 'failed') return 'failed';
  if (state === 'active') return 'running';
  return 'queued';
}

function createCloudReplayService(options = {}) {
  const redisUrl = options.redisUrl || process.env.REDIS_URL;
  const queueName = options.queueName || 'cloud-replay';

  const QueueClass = options.QueueClass;
  const connection = options.connection;

  let queue = options.queue || null;
  let initialized = false;

  const service = {
    enabled: !!redisUrl || !!queue,

    async init() {
      if (initialized) return;
      initialized = true;

      if (queue) {
        service.enabled = true;
        return;
      }

      if (!redisUrl) {
        service.enabled = false;
        return;
      }

      let LocalQueueClass = QueueClass;
      if (!LocalQueueClass) {
        // Lazy import so tests can run without Redis/BullMQ installed.
        const bull = await import('bullmq');
        LocalQueueClass = bull.Queue;
      }

      queue = new LocalQueueClass(queueName, {
        connection: connection || { url: redisUrl },
      });
      service.enabled = true;
    },

    async enqueue(payload) {
      await service.init();
      if (!queue) {
        throw new Error('cloud_replay_unavailable');
      }

      const job = await queue.add('cloud-replay-job', payload, {
        removeOnComplete: 100,
        removeOnFail: 100,
      });

      return String(job.id);
    },

    async getStatus(jobId) {
      await service.init();
      if (!queue) return null;

      const job = await queue.getJob(jobId);
      if (!job) return null;

      const state = await job.getState();
      return {
        jobId: String(job.id),
        status: mapBullStateToStatus(state),
        result: job.returnvalue || null,
        progress: job.progress || null,
        failedReason: job.failedReason || null,
      };
    },

    async close() {
      if (queue && typeof queue.close === 'function') {
        await queue.close();
      }
    },
  };

  return service;
}

export {
  createCloudReplayService,
  mapBullStateToStatus,
};
