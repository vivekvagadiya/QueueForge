import { authService } from '../services/auth.service.js';
import { unauthorized } from '../utils/AppError.js';

/** Requires `Authorization: Bearer <token>` and sets `req.user` to the active user. */
export const requireAuth = async (req, _res, next) => {
  try {
    const header = req.get('authorization') ?? '';
    const [scheme, token] = header.split(' ');

    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw unauthorized();
    }

    req.user = await authService.authenticate(token);
    next();
  } catch (err) {
    next(err);
  }
};
