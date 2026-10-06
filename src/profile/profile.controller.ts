import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  Patch,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { DatabaseService } from '../database/database.service';
import {
  bindingLabel,
  effectiveAccess,
  getUser,
  loadBinding,
} from '../database/access';
import {
  actorForUser,
  actorFromSession,
  insertAudit,
  sessionToken,
} from '../common/audit';
import { utcNow } from '../common/records';
import { bind } from '../common/sql';

const ALLOWED_FIELDS = new Set(['fullname', 'email', 'profile_image']);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const LOGIN_METHOD = 'Email & Password';
const ACCOUNT_TYPES: Record<string, string> = { HUMAN: 'Human', SERVICE: 'Service' };
const IMAGE_PATH = '/users/me/profile-image';

@Controller()
export class ProfileController {
  constructor(private readonly db: DatabaseService) {}

  private currentUser(req: Request) {
    const conn = this.db.connection;
    const actor = actorFromSession(conn, sessionToken(req));
    if (actor == null) throw new HttpException('authentication required', 401);
    const user = getUser(conn, actor.id!);
    if (user == null) throw new HttpException('authentication required', 401);
    return user;
  }

  private email(value: string) {
    const text = value.trim().toLowerCase();
    if (!text || !text.includes('@') || text.startsWith('@') || text.endsWith('@')) {
      throw new HttpException('email is invalid', 422);
    }
    return text;
  }

  private imageMime(data: Buffer) {
    if (
      data.length >= 8 &&
      data[0] === 0x89 &&
      data[1] === 0x50 &&
      data[2] === 0x4e &&
      data[3] === 0x47
    ) {
      return 'image/png';
    }
    if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
      return 'image/jpeg';
    }
    if (
      data.length >= 12 &&
      data.toString('ascii', 0, 4) === 'RIFF' &&
      data.toString('ascii', 8, 12) === 'WEBP'
    ) {
      return 'image/webp';
    }
    throw new HttpException('profile image must be PNG, JPEG, or WEBP', 422);
  }

  private profile(user: any) {
    const conn = this.db.connection;
    const now = utcNow();
    const access = effectiveAccess(conn, user.id);
    let role: { id: number; name: string } | null = null;
    if (access && access.role_id != null && access.role != null) {
      role = { id: access.role_id, name: access.role };
    }
    const lastLogin = conn
      .prepare(
        `SELECT timestamp FROM audit_logs
         WHERE actor_id = ? AND event_type = 'USER_LOGIN' AND outcome = 'SUCCESS'
         ORDER BY timestamp DESC, id DESC LIMIT 1`,
      )
      .get(user.id) as any;
    return {
      user: {
        id: user.id,
        identityType: user.identity_type,
        fullName: user.name,
        username: user.username,
        email: user.email,
        profileImageUrl: user.profile_image == null ? null : IMAGE_PATH,
        department: user.department,
        status: user.status,
        verification: user.verification,
        accessBinding: bindingLabel(loadBinding(conn, user.id), now),
        role,
        accountType: ACCOUNT_TYPES[user.identity_type] || user.identity_type,
        lastLoginAt: lastLogin == null ? null : lastLogin.timestamp,
        loginMethod: LOGIN_METHOD,
        memberSince: user.created_at,
      },
    };
  }

  @Get('auth/me')
  me(@Req() req: Request) {
    return this.profile(this.currentUser(req));
  }

  @Patch('users/me')
  @UseInterceptors(FileInterceptor('profile_image'))
  updateMe(
    @Req() req: Request,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    if (!contentType.includes('multipart/form-data')) {
      throw new HttpException('multipart/form-data required', 415);
    }
    const body = req.body || {};
    const keys = Object.keys(body);
    if (file) keys.push('profile_image');
    const rejected = keys.filter((k) => !ALLOWED_FIELDS.has(k)).sort();
    if (rejected.length) {
      throw new HttpException('field cannot be changed', 422);
    }
    const fullname = body.fullname != null ? String(body.fullname) : undefined;
    const email = body.email != null ? String(body.email) : undefined;
    let image: [Buffer, string] | null = null;
    if (file) {
      if (!file.buffer?.length && !file.size) {
        // empty upload with no filename treated as skip in Python when filename empty
      }
      if (file.originalname) {
        const data = file.buffer;
        if (!data?.length) throw new HttpException('profile image is empty', 422);
        if (data.length > MAX_IMAGE_BYTES) {
          throw new HttpException('profile image must be at most 5 MB', 422);
        }
        image = [data, this.imageMime(data)];
      }
    }
    const conn = this.db.connection;
    const user = this.currentUser(req);
    const fields: Record<string, unknown> = {};
    const metadata: Record<string, unknown> = {};
    if (fullname !== undefined) {
      const name = fullname.trim();
      if (!name) throw new HttpException('fullname is required', 422);
      if (name !== user.name) {
        fields.name = name;
        metadata.fullname = name;
      }
    }
    if (email !== undefined) {
      const normalized = this.email(email);
      if (normalized !== (user.email || '').toLowerCase()) {
        const taken = conn
          .prepare('SELECT id FROM users WHERE lower(email) = ? AND id != ?')
          .get(normalized, user.id);
        if (taken) throw new HttpException('email already exists', 409);
        fields.email = normalized;
        metadata.email = normalized;
      }
    }
    if (image != null) {
      fields.profile_image = image[0];
      fields.profile_image_mime = image[1];
      metadata.profile_image = true;
    }
    if (!Object.keys(fields).length) {
      throw new HttpException('no profile changes', 422);
    }
    fields.updated_at = utcNow();
    const assignments = Object.keys(fields)
      .map((c) => `${c} = ?`)
      .join(', ');
    try {
      conn
        .prepare(`UPDATE users SET ${assignments} WHERE id = ?`)
        .run(...bind([...Object.values(fields), user.id]));
    } catch (exc: any) {
      if (/UNIQUE/i.test(String(exc?.message))) {
        throw new HttpException('email already exists', 409);
      }
      throw exc;
    }
    const updated = getUser(conn, user.id);
    insertAudit(conn, {
      actor: actorForUser(conn, updated),
      category: 'USER_ACCESS',
      event_type: 'PROFILE_UPDATED',
      action: 'UPDATE',
      target: { id: updated.id, name: updated.name, type: 'USER' },
      description: 'Updated profile.',
      request: req,
      metadata,
    });
    return this.profile(updated);
  }

  @Get('users/me/profile-image')
  profileImage(@Req() req: Request, @Res() res: Response) {
    const user = this.currentUser(req);
    if (user.profile_image == null) {
      throw new HttpException('profile image not found', 404);
    }
    const mime = user.profile_image_mime || 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.send(Buffer.from(user.profile_image));
  }

  @Delete('users/me/profile-image')
  @HttpCode(204)
  removeImage(@Req() req: Request) {
    const conn = this.db.connection;
    const user = this.currentUser(req);
    if (user.profile_image == null) {
      throw new HttpException('profile image not found', 404);
    }
    conn
      .prepare(
        `UPDATE users SET profile_image = NULL, profile_image_mime = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(...bind([utcNow(), user.id]));
    insertAudit(conn, {
      actor: actorForUser(conn, user),
      category: 'USER_ACCESS',
      event_type: 'PROFILE_IMAGE_REMOVED',
      action: 'DELETE',
      target: { id: user.id, name: user.name, type: 'USER' },
      description: 'Removed profile image.',
      request: req,
    });
  }
}
