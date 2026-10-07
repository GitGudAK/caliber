// Errors that carry an HTTP status. The global error handler in app.ts maps
// these to { error } JSON; anything else becomes a 500 with its real message.
export class HttpError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 413 | 416 | 500,
    message: string,
  ) {
    super(message)
  }
}

export const badRequest = (message: string) => new HttpError(400, message)
export const notFound = (message: string) => new HttpError(404, message)
