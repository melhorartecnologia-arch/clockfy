export class HttpError extends Error {
  constructor(status, message, code, details) {
    super(message);
    this.status = status;
    this.code = code || status;
    this.details = details;
  }
}

export const badRequest = (message = 'Bad request', code, details) => new HttpError(400, message, code, details);
export const unauthorized = (message = 'Unauthorized', code) => new HttpError(401, message, code);
export const forbidden = (message = 'Forbidden', code) => new HttpError(403, message, code);
export const notFound = (message = 'Not found', code) => new HttpError(404, message, code);
export const conflict = (message = 'Conflict', code) => new HttpError(409, message, code);

export function assert(condition, error) {
  if (!condition) throw typeof error === 'string' ? badRequest(error) : error;
}
