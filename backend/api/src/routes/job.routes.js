import { Router } from 'express';
import { getJob } from '../controllers/job.controller.js';
import { requireAuth } from '../middlewares/requireAuth.js';
import { validate } from '../middlewares/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getJobSchema } from '../validators/job.validator.js';

const router = Router();

router.use(requireAuth);

router.get('/:jobId', validate(getJobSchema), asyncHandler(getJob));

export default router;
