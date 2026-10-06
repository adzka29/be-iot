import { Module } from '@nestjs/common';
import { BindingsController } from './bindings.controller';

@Module({ controllers: [BindingsController] })
export class BindingsModule {}
