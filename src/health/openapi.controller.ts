import { Controller, Get } from '@nestjs/common';

/**
 * Minimal OpenAPI document covering paths/schemas asserted by the legacy
 * Python e2e suite. Not a full generator — just enough for contract checks.
 */
@Controller()
export class OpenApiController {
  @Get('openapi.json')
  openapi() {
    return {
      openapi: '3.0.0',
      info: { title: 'TrackForge Backend', version: '0.1.0' },
      paths: {
        '/api/alerts/sos': {},
        '/api/alerts/{alert_id}/acknowledge': {},
        '/api/history/track': {},
        '/api/history/point/{record_id}': {},
        '/users/login': {},
        '/audit-logs/me': {},
      },
      components: {
        schemas: {
          AlertOut: {
            properties: {
              alert_code: { type: 'string' },
              source_record: { type: 'object', nullable: true },
            },
          },
        },
      },
    };
  }
}
