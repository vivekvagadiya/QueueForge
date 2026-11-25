import { ZodError } from 'zod';
import { logger } from '../config/logger.js';

export const errorHandler = (err, req, res, _next) => {
  let statusCode = err.statusCode || 500;
  let code = err.code || 'INTERNAL_ERROR';
  let message = err.isOperational ? err.message : 'Internal server error';
  let details = err.details ?? null;

  if (err instanceof ZodError) {
    statusCode = 400;
    code = 'VALIDATION_ERROR';
    message = 'Request validation failed';
    details = err.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
  } else if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    statusCode = 400;
    code = 'INVALID_JSON';
    message = 'Malformed JSON request body';
  }

  const logPayload = {
    err,
    statusCode,
    code,
    method: req.method,
    path: req.originalUrl,
  };

  if (statusCode >= 500) {
    logger.error(logPayload, err.message);
  } else {
    logger.warn(logPayload, message);
  }

  const response = {
    success: false,
    error: {
      code,
      message,
    },
  };

  if (details !== null) {
    response.error.details = details;
  }

  res.status(statusCode).json(response);
};
