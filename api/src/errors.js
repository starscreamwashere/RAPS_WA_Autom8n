class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const notFound = (what) => new HttpError(404, 'NOT_FOUND', `${what} not found`);

module.exports = { HttpError, notFound };
