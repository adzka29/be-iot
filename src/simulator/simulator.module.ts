import { Module } from '@nestjs/common';
import { LiveSimulatorService } from './live-simulator.service';

@Module({
  providers: [LiveSimulatorService],
})
export class SimulatorModule {}
