import { Router } from 'express';
import { getDashboard } from '../controllers/dashboard.controller.js';
import { requireAuth } from '../middlewares/requireAuth.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = Router();

router.use(requireAuth);
router.get('/', asyncHandler(getDashboard));

export default router;
