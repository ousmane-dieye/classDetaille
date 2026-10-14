import { Injectable } from '@nestjs/common';
import { ApiError } from '../../http/errors.js';
import type { Actor } from './actor.js';
import { can, type Action } from './matrix.js';

@Injectable()
export class AuthzService {
  assert(actor: Actor, action: Action): void {
    if (!can(actor, action)) throw new ApiError(403, 'FORBIDDEN');
  }
}
