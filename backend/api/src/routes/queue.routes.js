import { Router } from 'express';
import { createQueue, getQueue, listQueues, updateQueue } from '../controllers/queue.controller.js';
import { listJobs, submitJob } from '../controllers/job.controller.js';
import { requireAuth } from '../middlewares/requireAuth.js';
import { validate } from '../middlewares/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  createQueueSchema,
  getQueueSchema,
  listQueuesSchema,
  updateQueueSchema,
} from '../validators/queue.validator.js';
import { createJobSchema, listJobsSchema } from '../validators/job.validator.js';

const router = Router();

router.use(requireAuth);

router.post('/', validate(createQueueSchema), asyncHandler(createQueue));
router.get('/', validate(listQueuesSchema), asyncHandler(listQueues));
router.get('/:queueId', validate(getQueueSchema), asyncHandler(getQueue));
router.patch('/:queueId', validate(updateQueueSchema), asyncHandler(updateQueue));

router.post('/:queueId/jobs', validate(createJobSchema), asyncHandler(submitJob));
router.get('/:queueId/jobs', validate(listJobsSchema), asyncHandler(listJobs));

export default router;
