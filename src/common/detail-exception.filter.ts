import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';

/**
 * Mirror FastAPI's `{ "detail": ... }` error body so clients (and e2e tests)
 * see the same shape as the Python API.
 */
@Catch()
export class DetailExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      let detail: unknown =
        typeof payload === 'string'
          ? payload
          : (payload as { message?: unknown; detail?: unknown }).detail ??
            (payload as { message?: unknown }).message ??
            payload;
      if (
        detail &&
        typeof detail === 'object' &&
        !Array.isArray(detail) &&
        'message' in (detail as object)
      ) {
        detail = (detail as { message: unknown }).message;
      }
      response.status(status).json({ detail });
      return;
    }

    const message =
      exception instanceof Error ? exception.message : 'Internal server error';
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ detail: message });
  }
}
