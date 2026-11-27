import { workerService } from '../services/worker.service.js';

export const listWorkers = async (req, res) => {
  const result = await workerService.list({ userId: req.user.id, ...req.validated.query });
  res.status(200).json({ success: true, ...result });
};
