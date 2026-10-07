import { Module } from '@nestjs/common';
import { PersonnelController } from './personnel.controller';

@Module({
  controllers: [PersonnelController],
})
export class PersonnelModule {}
