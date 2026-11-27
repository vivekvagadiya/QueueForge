import { Router } from 'express';
import { listWorkers } from '../controllers/worker.controller.js';
import { requireAuth } from '../middlewares/requireAuth.js';
import { validate } from '../middlewares/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { listWorkersSchema } from '../validators/worker.validator.js';

const router = Router();

router.use(requireAuth);

router.get('/', validate(listWorkersSchema), asyncHandler(listWorkers));

export default router;
