import type { FastifyInstance } from 'fastify';
import { clockRoutes } from './clock-routes';
import { rotaRoutes } from './rota-routes';
import { timesheetRoutes } from './timesheet-routes';

/** Phase 4: rotas, clocking (PWA + kiosk), timesheets and working-time records. */
export async function timeRoutes(app: FastifyInstance) {
  await rotaRoutes(app);
  await clockRoutes(app);
  await timesheetRoutes(app);
}
