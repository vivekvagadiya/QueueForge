import { HandlerRegistry } from '../handlerRegistry.js';
import { builtinHandlers } from './builtin.js';

/**
 * The registry used by the worker process. Register application handlers here:
 *
 *   registry.register('email.send', async ({ job, signal }) => { ... });
 *
 * Every worker process uses the same registry. A job whose name has no handler
 * fails permanently with HANDLER_NOT_FOUND.
 */
export const createDefaultRegistry = () => {
  const registry = new HandlerRegistry();
  for (const [name, handler] of Object.entries(builtinHandlers)) {
    registry.register(name, handler);
  }
  return registry;
};
