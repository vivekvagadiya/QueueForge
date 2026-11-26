/**
 * Validates request parts with Zod schemas and stores the parsed values on
 * `req.validated` ({ params, query, body }). Parsing applies coercion and
 * defaults, so handlers must read from `req.validated`, not the raw request.
 * A ZodError is converted to a 400 VALIDATION_ERROR by the error handler.
 */
export const validate =
  (schemas) =>
  (req, _res, next) => {
    try {
      req.validated = {
        params: schemas.params ? schemas.params.parse(req.params) : req.params,
        query: schemas.query ? schemas.query.parse(req.query) : req.query,
        body: schemas.body ? schemas.body.parse(req.body ?? {}) : req.body,
      };
      next();
    } catch (err) {
      next(err);
    }
  };
