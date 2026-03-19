import express from 'express';
import type { Server } from 'node:http';
import helmet from 'helmet';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IrisConfig } from '../types/config.js';
import type { IStorageAdapter } from '../types/query.js';
import type { Logger } from '../utils/logger.js';
import { createAuthMiddleware } from '../middleware/auth.js';
import { createCorsMiddleware } from '../middleware/cors.js';
import { createErrorHandler } from '../middleware/error-handler.js';
import { createMcpRateLimiter } from '../middleware/rate-limit.js';
import { createDashboardRouter, mountDashboardStatic } from '../dashboard/server.js';

export interface HttpTransportResult {
  transport: StreamableHTTPServerTransport;
  httpServer: Server;
}

export async function createHttpTransport(
  mcpServer: McpServer,
  config: IrisConfig,
  logger: Logger,
  storage?: IStorageAdapter,
): Promise<HttpTransportResult> {
  const app = express();
  const dashboardEnabled = config.dashboard.enabled && storage != null;

  // Security headers — use explicit CSP when the dashboard UI is also served,
  // otherwise rely on Helmet's secure defaults
  app.use(helmet(
    dashboardEnabled
      ? {
          contentSecurityPolicy: {
            directives: {
              defaultSrc: ["'self'"],
              scriptSrc: ["'self'"],
              styleSrc: ["'self'", "'unsafe-inline'"],
              connectSrc: ["'self'"],
            },
          },
        }
      : {},
  ));

  // Body parser with size limit
  app.use(express.json({ limit: config.security.requestSizeLimit }));

  // CORS
  app.use(createCorsMiddleware(config.security.allowedOrigins));

  // Health endpoint (no auth, no rate limit)
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', server: 'iris-eval', timestamp: new Date().toISOString() });
  });

  // Authentication
  app.use(createAuthMiddleware(config));

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });

  // Rate limiter for MCP POST/DELETE (not GET — SSE streaming)
  const mcpLimiter = createMcpRateLimiter(config);

  app.post('/mcp', mcpLimiter, async (req, res) => {
    await transport.handleRequest(req, res, req.body);
  });

  app.get('/mcp', async (req, res) => {
    await transport.handleRequest(req, res);
  });

  app.delete('/mcp', mcpLimiter, async (req, res) => {
    await transport.handleRequest(req, res);
  });

  // When dashboard is enabled, mount the dashboard API and static files on the
  // same Express app so that a single port serves everything.
  if (dashboardEnabled) {
    app.use('/api/v1', createDashboardRouter(storage, config));
    mountDashboardStatic(app, config);
  }

  // Error handler (must be last)
  app.use(createErrorHandler(logger));

  const httpServer = await new Promise<Server>((resolve) => {
    const server = app.listen(config.transport.port, config.transport.host, () => resolve(server));
  });

  return { transport, httpServer };
}
