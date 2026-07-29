export type ApiErrorShape = {
  message: string;
  code?: string;
  details?: any;
};

export class AppError extends Error {
  public status: number;
  public code?: string;
  public details?: any;

  constructor(message: string, status = 500, code?: string, details?: any) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ValidationError extends AppError {
  constructor(message = "Validation failed", details?: any) {
    super(message, 400, "validation_error", details);
  }
}

export class AuthenticationError extends AppError {
  constructor(message = "Authentication required") {
    super(message, 401, "authentication_error");
  }
}

export class AuthorizationError extends AppError {
  constructor(message = "Not authorized") {
    super(message, 403, "authorization_error");
  }
}

export class IntegrationError extends AppError {
  constructor(message = "Integration error", details?: any) {
    super(message, 502, "integration_error", details);
  }
}

export class DatabaseError extends AppError {
  constructor(message = "Database error", details?: any) {
    super(message, 500, "database_error", details);
  }
}

export class AIError extends AppError {
  constructor(message = "AI error", details?: any) {
    super(message, 500, "ai_error", details);
  }
}

export function apiSuccess<T = any>(data: T, message = "OK") {
  return {
    success: true,
    message,
    data,
  } as const;
}

export function apiFailure(message = "Error", errors: ApiErrorShape[] = []) {
  return {
    success: false,
    message,
    errors,
  } as const;
}
