import { User } from '../models/index.js';

export const userRepository = {
  create: ({ name, email, passwordHash }) => User.create({ name, email, passwordHash }),

  /** Includes passwordHash; use only for credential checks. */
  findByEmailWithPassword: (email) => User.unscoped().findOne({ where: { email } }),

  findActiveById: (id) => User.findOne({ where: { id, status: 'ACTIVE' } }),
};
