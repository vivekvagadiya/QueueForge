import { Router } from 'express';
import healthRoutes from './health.routes.js';
import authRoutes from './auth.routes.js';
import dashboardRoutes from './dashboard.routes.js';
import queueRoutes from './queue.routes.js';
import jobRoutes from './job.routes.js';
import workerRoutes from './worker.routes.js';

const router = Router();

router.use('/health', healthRoutes);
router.use('/auth', authRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/queues', queueRoutes);
router.use('/jobs', jobRoutes);
router.use('/workers', workerRoutes);

export default router;
