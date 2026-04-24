import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const exceptionResponse =
      exception instanceof HttpException ? exception.getResponse() : 'Internal server error';
    const normalized: { detail: string | string[]; extras: Record<string, unknown> } =
      typeof exceptionResponse === 'string'
        ? { detail: exceptionResponse, extras: {} }
        : this.normalizeResponse(exceptionResponse);

    this.logger.error(`${request.method} ${request.url} → ${status}`, {
      exception,
    });

    response.status(status).json({
      type: `https://httpstatuses.com/${status}`,
      title: HttpStatus[status] ?? 'Error',
      status,
      detail: normalized.detail,
      ...normalized.extras,
    });
  }

  private normalizeResponse(
    exceptionResponse: object,
  ): { detail: string | string[]; extras: Record<string, unknown> } {
    const responseRecord = exceptionResponse as Record<string, unknown>;
    const detail =
      typeof responseRecord.message === 'string' || Array.isArray(responseRecord.message)
        ? responseRecord.message
        : 'Request failed';

    const { message: _message, error: _error, statusCode: _statusCode, ...extras } = responseRecord;
    return { detail, extras };
  }
}
