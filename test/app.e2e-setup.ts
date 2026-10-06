import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AppModule } from '../src/app.module';
import { DetailExceptionFilter } from '../src/common/detail-exception.filter';
import { DatabaseService } from '../src/database/database.service';

export type TestApp = {
  app: INestApplication;
  moduleRef: TestingModule;
  dbPath: string;
  close: () => Promise<void>;
};

export async function createTestApp(): Promise<TestApp> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-'));
  const dbPath = path.join(dir, 'trackforge.db');
  process.env.TRACKFORGE_DB = dbPath;
  process.env.TRACKFORGE_SEED = '1';

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: false,
    }),
  );
  app.useGlobalFilters(new DetailExceptionFilter());
  await app.init();

  return {
    app,
    moduleRef,
    dbPath,
    close: async () => {
      try {
        moduleRef.get(DatabaseService).close();
      } catch {
        /* ignore */
      }
      await app.close();
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}
