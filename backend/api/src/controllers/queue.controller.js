import { queueService } from '../services/queue.service.js';

export const createQueue = async (req, res) => {
  const queue = await queueService.create({ userId: req.user.id, ...req.validated.body });
  res.status(201).json({ success: true, data: queue });
};

export const listQueues = async (req, res) => {
  const result = await queueService.list({ userId: req.user.id, ...req.validated.query });
  res.status(200).json({ success: true, ...result });
};

export const getQueue = async (req, res) => {
  const queue = await queueService.get({ userId: req.user.id, ...req.validated.params });
  res.status(200).json({ success: true, data: queue });
};

export const updateQueue = async (req, res) => {
  const queue = await queueService.update({
    userId: req.user.id,
    queueId: req.validated.params.queueId,
    changes: req.validated.body,
  });
  res.status(200).json({ success: true, data: queue });
};
