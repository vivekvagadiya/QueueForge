import { jobService } from '../services/job.service.js';
import { idempotencyKey } from '../validators/job.validator.js';

export const submitJob = async (req, res) => {
  const rawHeader = req.get('idempotency-key');
  const headerIdempotencyKey = rawHeader === undefined ? undefined : idempotencyKey.parse(rawHeader);

  const { job, created } = await jobService.submit({
    userId: req.user.id,
    queueId: req.validated.params.queueId,
    input: req.validated.body,
    headerIdempotencyKey,
  });

  // 201 for a new job; 200 when an idempotent replay returns the existing one.
  res
    .status(created ? 201 : 200)
    .set('Idempotent-Replayed', String(!created))
    .json({ success: true, data: job });
};

export const listJobs = async (req, res) => {
  const result = await jobService.list({
    userId: req.user.id,
    queueId: req.validated.params.queueId,
    ...req.validated.query,
  });
  res.status(200).json({ success: true, ...result });
};

export const getJob = async (req, res) => {
  const job = await jobService.get({ userId: req.user.id, jobId: req.validated.params.jobId });
  res.status(200).json({ success: true, data: job });
};
