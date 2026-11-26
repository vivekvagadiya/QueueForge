import { authService } from '../services/auth.service.js';
import { serializeUser } from '../services/serializers.js';

export const register = async (req, res) => {
  const result = await authService.register(req.validated.body);
  res.status(201).json({ success: true, data: result });
};

export const login = async (req, res) => {
  const result = await authService.login(req.validated.body);
  res.status(200).json({ success: true, data: result });
};

export const me = (req, res) => {
  res.status(200).json({ success: true, data: serializeUser(req.user) });
};
