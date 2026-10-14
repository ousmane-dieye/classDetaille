import { Global, Module, type DynamicModule } from '@nestjs/common';
import { Clock, SystemClock } from './clock.js';

@Global()
@Module({})
export class CoreModule {
  static forRoot(clock: Clock = new SystemClock()): DynamicModule {
    return { module: CoreModule, providers: [{ provide: Clock, useValue: clock }], exports: [Clock] };
  }
}
