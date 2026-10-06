import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';

export const REQUIRE_PERMISSION_KEY = 'require_permission';

export type PermissionRequirement = { domain: string; action: string };

export const RequirePermission = (domain: string, action = 'read') =>
  SetMetadata(REQUIRE_PERMISSION_KEY, { domain, action } satisfies PermissionRequirement);

export const XUserId = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest();
  const raw = req.headers['x-user-id'];
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
});

export const SessionToken = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest();
  const header = (req.headers['authorization'] as string) || '';
  if (header.toLowerCase().startsWith('bearer ')) {
    const token = header.slice(7).trim();
    if (token) return token;
  }
  const sid = ((req.headers['x-session-id'] as string) || '').trim();
  return sid || null;
});
