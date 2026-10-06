import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { OpenApiController } from './openapi.controller';

@Module({ controllers: [HealthController, OpenApiController] })
export class HealthModule {}
