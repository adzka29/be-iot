import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DatabaseService } from '../database/database.service';
import { effectiveAccess, hasPermission } from '../database/access';
import {
  REQUIRE_PERMISSION_KEY,
  PermissionRequirement,
} from './auth.decorators';

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly db: DatabaseService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const requirement = this.reflector.getAllAndOverride<PermissionRequirement | undefined>(
      REQUIRE_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!requirement) return true;
    const req = context.switchToHttp().getRequest();
    const raw = req.headers['x-user-id'];
    if (raw == null || raw === '') {
      throw new HttpException('authentication required', 401);
    }
    const userId = Number(raw);
    if (!Number.isFinite(userId)) {
      throw new HttpException('authentication required', 401);
    }
    const access = effectiveAccess(this.db.connection, userId);
    const granted = new Set(access?.permissions ?? []);
    if (!hasPermission(granted, requirement.domain, requirement.action)) {
      throw new HttpException('permission denied', 403);
    }
    return true;
  }
}
