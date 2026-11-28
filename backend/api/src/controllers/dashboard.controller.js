import { dashboardRepository } from '../repositories/dashboard.repository.js';

export const getDashboard = async (req, res) => {
  const summary = await dashboardRepository.getSummary(req.user.id);
  res.status(200).json({ success: true, data: summary });
};
