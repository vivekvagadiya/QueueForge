const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

export const registerShutdownHandlers = ({
  logger,
  onShutdown,
  timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
}) => {
  let isShuttingDown = false;

  const shutdown = async (signal, exitCode = 0) => {
    if (isShuttingDown) {
      return;
    }
    isShuttingDown = true;

    logger.info({ signal }, 'Shutting down QueueForge worker');

    const forceTimer = setTimeout(() => {
      logger.error('Forced worker shutdown due to timeout');
      process.exit(1);
    }, timeoutMs);
    forceTimer.unref();

    try {
      await onShutdown();
      clearTimeout(forceTimer);
      logger.info('QueueForge worker shutdown complete');
      process.exit(exitCode);
    } catch (err) {
      clearTimeout(forceTimer);
      logger.error({ err }, 'Error during worker shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT', 0));
  process.on('SIGTERM', () => shutdown('SIGTERM', 0));

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'Unhandled promise rejection in worker');
    shutdown('unhandledRejection', 1);
  });

  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception in worker');
    shutdown('uncaughtException', 1);
  });
};
