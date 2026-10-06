import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, TestApp } from './app.e2e-setup';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(16)]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP'),
  Buffer.alloc(16),
]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(16)]);

async function login(app: INestApplication) {
  const logged = await request(app.getHttpServer())
    .post('/users/login')
    .send({ account: 'superadmin', password: 'superadmin' });
  expect(logged.status).toBe(200);
  return { Authorization: `Bearer ${logged.body.session_id}` };
}

describe('Profile e2e (ported from test_profile.py)', () => {
  let harness: TestApp;
  let app: INestApplication;

  beforeEach(async () => {
    harness = await createTestApp();
    app = harness.app;
  });

  afterEach(async () => {
    await harness.close();
  });

  it('profile_reads_existing_account_fields', async () => {
    const headers = await login(app);
    const response = await request(app.getHttpServer()).get('/auth/me').set(headers);
    expect(response.status).toBe(200);
    const user = response.body.user;
    expect(user.fullName).toBe('Superadmin');
    expect(user.username).toBe('superadmin');
    expect(user.email).toBe('superadmin@trackforge.id');
    expect(user.profileImageUrl).toBeNull();
    expect(user.department).toBe('Platform Administration');
    expect(user.status).toBe('ACTIVE');
    expect(user.verification).toBe('VERIFIED');
    expect(user.accessBinding).toBe('BOUND');
    expect(user.role.name).toBe('superadmin');
    expect(user.accountType).toBe('Human');
    expect(user.identityType).toBe('HUMAN');
    expect(user.loginMethod).toBe('Email & Password');
    expect(user.memberSince.endsWith('Z')).toBe(true);
    expect(user.lastLoginAt.endsWith('Z')).toBe(true);
    expect(user).not.toHaveProperty('phone');
    expect(user).not.toHaveProperty('bio');
    expect((await request(app.getHttpServer()).get('/auth/me')).status).toBe(401);
  });

  it('profile_updates_name_email_and_image_only', async () => {
    const headers = await login(app);
    const rejected = await request(app.getHttpServer())
      .patch('/users/me')
      .set(headers)
      .field('fullname', 'Hacked')
      .field('username', 'root')
      .field('role', 'superadmin')
      .field('status', 'ACTIVE');
    expect(rejected.status).toBe(422);
    expect(rejected.body.detail).toBe('field cannot be changed');
    const unchanged = (
      await request(app.getHttpServer()).get('/auth/me').set(headers)
    ).body.user;
    expect(unchanged.fullName).toBe('Superadmin');
    expect(unchanged.username).toBe('superadmin');

    const jsonBody = await request(app.getHttpServer())
      .patch('/users/me')
      .set(headers)
      .send({ fullname: 'Nope', role: 'viewer' });
    expect(jsonBody.status).toBe(415);

    const updated = await request(app.getHttpServer())
      .patch('/users/me')
      .set(headers)
      .field('fullname', '  Administrator Baru  ')
      .field('email', 'AdminBaru@Trackforge.id')
      .attach('profile_image', PNG, {
        filename: 'avatar.png',
        contentType: 'image/png',
      });
    expect(updated.status).toBe(200);
    const user = updated.body.user;
    expect(user.fullName).toBe('Administrator Baru');
    expect(user.email).toBe('adminbaru@trackforge.id');
    expect(user.username).toBe('superadmin');
    expect(user.department).toBe('Platform Administration');
    expect(user.role.name).toBe('superadmin');
    expect(user.profileImageUrl).toBe('/users/me/profile-image');

    const image = await request(app.getHttpServer())
      .get('/users/me/profile-image')
      .set(headers);
    expect(image.status).toBe(200);
    expect(Buffer.compare(image.body as Buffer, PNG)).toBe(0);
    expect(image.headers['content-type'].startsWith('image/png')).toBe(true);

    const jpeg = await request(app.getHttpServer())
      .patch('/users/me')
      .set(headers)
      .attach('profile_image', JPEG, {
        filename: 'avatar.jpg',
        contentType: 'image/jpeg',
      });
    expect(jpeg.status).toBe(200);
    expect(
      (
        await request(app.getHttpServer())
          .get('/users/me/profile-image')
          .set(headers)
      ).headers['content-type'].startsWith('image/jpeg'),
    ).toBe(true);
    const webp = await request(app.getHttpServer())
      .patch('/users/me')
      .set(headers)
      .attach('profile_image', WEBP, {
        filename: 'avatar.webp',
        contentType: 'image/webp',
      });
    expect(webp.status).toBe(200);

    const gif = await request(app.getHttpServer())
      .patch('/users/me')
      .set(headers)
      .attach('profile_image', GIF, {
        filename: 'avatar.gif',
        contentType: 'image/gif',
      });
    expect(gif.status).toBe(422);
    const kept = await request(app.getHttpServer())
      .get('/users/me/profile-image')
      .set(headers);
    expect(kept.headers['content-type'].startsWith('image/webp')).toBe(true);
    expect(Buffer.compare(kept.body as Buffer, WEBP)).toBe(0);

    const huge = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(5 * 1024 * 1024),
    ]);
    const oversized = await request(app.getHttpServer())
      .patch('/users/me')
      .set(headers)
      .attach('profile_image', huge, {
        filename: 'big.png',
        contentType: 'image/png',
      });
    expect(oversized.status).toBe(422);

    const created = await request(app.getHttpServer())
      .post('/users/human')
      .send({
        name: 'Sari Profile',
        username: 'sari.profile',
        email: 'sari.profile@trackforge.id',
        password: 'temporary-password',
      });
    expect(created.status).toBe(201);
    const duplicate = await request(app.getHttpServer())
      .patch('/users/me')
      .set(headers)
      .field('email', 'sari.profile@trackforge.id');
    expect(duplicate.status).toBe(409);
    expect(
      (await request(app.getHttpServer()).get('/auth/me').set(headers)).body.user
        .email,
    ).toBe('adminbaru@trackforge.id');

    const empty = await request(app.getHttpServer())
      .patch('/users/me')
      .set(headers)
      .field('fullname', 'Administrator Baru');
    expect(empty.status).toBe(422);

    const activity = await request(app.getHttpServer())
      .get('/audit-logs/me')
      .set(headers);
    expect(activity.status).toBe(200);
    const events = activity.body.items.map((item: any) => item.event);
    expect(events).toContain('Profile Updated');

    const removed = await request(app.getHttpServer())
      .delete('/users/me/profile-image')
      .set(headers);
    expect(removed.status).toBe(204);
    expect(
      (
        await request(app.getHttpServer())
          .get('/users/me/profile-image')
          .set(headers)
      ).status,
    ).toBe(404);
    expect(
      (await request(app.getHttpServer()).get('/auth/me').set(headers)).body.user
        .profileImageUrl,
    ).toBeNull();
    expect(
      (
        await request(app.getHttpServer())
          .delete('/users/me/profile-image')
          .set(headers)
      ).status,
    ).toBe(404);
    const again = (
      await request(app.getHttpServer()).get('/audit-logs/me').set(headers)
    ).body.items;
    expect(again.some((item: any) => item.event === 'Profile Image Removed')).toBe(
      true,
    );
    const detail = await request(app.getHttpServer())
      .get(`/audit-logs/${again[0].eventId}`)
      .set(headers);
    expect(detail.status).toBe(200);
    expect(detail.body.eventType).toBe('PROFILE_IMAGE_REMOVED');
  });
});
