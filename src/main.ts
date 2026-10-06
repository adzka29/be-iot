import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { DetailExceptionFilter } from './common/detail-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: false,
    }),
  );
  app.useGlobalFilters(new DetailExceptionFilter());
  const port = Number(process.env.PORT || 8000);
  await app.listen(port, '0.0.0.0');
}

bootstrap();
