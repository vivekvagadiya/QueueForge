import { WORKER_STATUSES } from '../models/worker.model.js';
import { paginationQuery, statusListQuery } from './common.validator.js';

export const listWorkersSchema = {
  query: paginationQuery.extend({ status: statusListQuery(WORKER_STATUSES) }),
};
