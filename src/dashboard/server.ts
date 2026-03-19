import express from 'express';
import type { Router, Application } from 'express';
import type { Server } from 'node:http';
import helmet from 'helmet';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import type { IStorageAdapter } from '../types/query.js';
import type { IrisConfig } from '../types/config.js';
import type { Logger } from '../utils/logger.js';
import { createAuthMiddleware } from '../middleware/auth.js';
import { createCorsMiddleware } from '../middleware/cors.js';
import { createErrorHandler } from '../middleware/error-handler.js';
import { createApiRateLimiter } from '../middleware/rate-limit.js';
import { registerTraceRoutes } from './routes/traces.js';
import { registerSummaryRoutes } from './routes/summary.js';
import { registerEvaluationRoutes } from './routes/evaluations.js';
import { registerFilterRoutes } from './routes/filters.js';
import { registerHealthRoutes } from './routes/health.js';

export interface DashboardServer {
  app: Application;
  start(): Server;
}

/**
 * Creates an Express Router with all dashboard API routes. Can be mounted onto
 * any existing Express app (e.g., the MCP HTTP transport app) so that both
 * the MCP transport and the dashboard share a single port.
 */
export function createDashboardRouter(storage: IStorageAdapter, config: IrisConfig): Router {
  const router = express.Router();
  router.use(createApiRateLimiter(config));
  registerTraceRoutes(router, storage);
  registerSummaryRoutes(router, storage);
  registerEvaluationRoutes(router, storage);
  registerFilterRoutes(router, storage);
  registerHealthRoutes(router, storage);
  return router;
}

/**
 * Mounts static dashboard files onto an Express app if they have been built.
 * Returns true if the static files were found and mounted.
 */
export function mountDashboardStatic(app: Application, config: IrisConfig): boolean {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const staticDir = join(currentDir, '..', '..', 'dist', 'dashboard');
  if (existsSync(staticDir)) {
    app.use(express.static(staticDir));
    // SPA fallback: rate-limited to prevent file-system abuse
    const limiter = createApiRateLimiter(config);
    app.get('/{*path}', limiter, (_req, res) => {
      res.sendFile(join(staticDir, 'index.html'));
    });
    return true;
  }
  return false;
}

export function createDashboardServer(
  storage: IStorageAdapter,
  config: IrisConfig,
  logger: Logger,
): DashboardServer {
  const app = express();

  // Security headers
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'"],
      },
    },
  }));

  // Body parser with size limit
  app.use(express.json({ limit: config.security.requestSizeLimit }));

  // CORS
  app.use(createCorsMiddleware(config.security.allowedOrigins));

  // Authentication
  app.use(createAuthMiddleware(config));

  // API routes with rate limiting
  app.use('/api/v1', createDashboardRouter(storage, config));

  // Serve static dashboard files if built
  mountDashboardStatic(app, config);

  // Error handler (must be last)
  app.use(createErrorHandler(logger));

  return {
    app,
    start() {
      return app.listen(config.dashboard.port, () => {
        logger.info(`Dashboard available at http://localhost:${config.dashboard.port}`);
      });
    },
  };
}
