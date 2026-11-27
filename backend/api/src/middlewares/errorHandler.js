import { ZodError } from 'zod';
import { ConnectionError, ForeignKeyConstraintError, UniqueConstraintError } from 'sequelize';
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
  } else if (err.type === 'entity.too.large') {
    statusCode = 413;
    code = 'PAYLOAD_TOO_LARGE';
    message = 'Request body is too large';
  } else if (err instanceof UniqueConstraintError) {
    // Services translate expected conflicts; this is the safety net for races.
    statusCode = 409;
    code = 'CONFLICT';
    message = 'Resource already exists';
  } else if (err instanceof ForeignKeyConstraintError) {
    statusCode = 409;
    code = 'CONFLICT';
    message = 'Operation conflicts with related resources';
  } else if (err instanceof ConnectionError) {
    statusCode = 503;
    code = 'SERVICE_UNAVAILABLE';
    message = 'Database is unavailable';
  }

  const logPayload = {
    // Explicit: errors raised by the body parsers occur outside the request context.
    correlationId: req.id,
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

  // Lets users quote the ID when reporting a problem; it matches the server logs.
  if (req.id) {
    response.error.requestId = req.id;
  }

  if (details !== null) {
    response.error.details = details;
  }

  res.status(statusCode).json(response);
};
