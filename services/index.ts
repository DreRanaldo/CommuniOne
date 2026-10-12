// CommuniOne service layer: business operations for the mobile and admin apps.
//
//   import { createClient } from '@supabase/supabase-js';
//   import { createServices } from './services/index.ts';
//
//   const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY);
//   const services = createServices(supabase, { logger: consoleLogger });
//   await services.posts.create({ communityId, body: 'Hello' });
//
// Use ONLY a client created with the anon / publishable key and the user's
// session. Never pass a service-role client: it bypasses Row Level Security.
// See docs/api/README.md.

import { createContext, type Db, type ErrorListener } from './core/context.ts';
import type { Logger } from './core/logger.ts';
import { alertsService } from './alerts/index.ts';
import { announcementsService } from './announcements/index.ts';
import { auditService } from './audit/index.ts';
import { authService } from './auth/index.ts';
import { commentsService } from './comments/index.ts';
import { communitiesService } from './communities/index.ts';
import { documentsService } from './documents/index.ts';
import { eventsService } from './events/index.ts';
import { invitationsService } from './invitations/index.ts';
import { membershipsService } from './memberships/index.ts';
import { notificationsService } from './notifications/index.ts';
import { postsService } from './posts/index.ts';
import { rolesService } from './roles/index.ts';

export interface ServicesOptions {
  logger?: Logger;
  /** Notified of every failed operation (after translation and logging). */
  onError?: ErrorListener;
}

export function createServices(db: Db, options: ServicesOptions = {}) {
  const ctx = createContext(db, options.logger, options.onError);
  return {
    auth: authService(ctx),
    communities: communitiesService(ctx),
    memberships: membershipsService(ctx),
    roles: rolesService(ctx),
    invitations: invitationsService(ctx),
    posts: postsService(ctx),
    comments: commentsService(ctx),
    announcements: announcementsService(ctx),
    alerts: alertsService(ctx),
    events: eventsService(ctx),
    notifications: notificationsService(ctx),
    documents: documentsService(ctx),
    audit: auditService(ctx),
  };
}

export type Services = ReturnType<typeof createServices>;

export { ErrorCode, ServiceError, isServiceError, type ErrorDetails } from './core/errors.ts';
export type { ErrorListener } from './core/context.ts';
export { AUTH_LINK_KINDS, type AuthLinkKind } from './auth/index.ts';
export { consoleLogger, silentLogger, redact, type Logger, type LogLevel } from './core/logger.ts';
export { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, type Page, type PageRequest } from './core/pagination.ts';
export type { Database } from './database.types.ts';
export { parseInvitationToken } from './invitations/index.ts';
