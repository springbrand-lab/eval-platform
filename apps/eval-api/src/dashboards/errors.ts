export class DashboardNotFoundError extends Error {
  constructor(readonly dashboardId: string) {
    super(`Unknown Dashboard ${dashboardId}`);
    this.name = "DashboardNotFoundError";
  }
}

export class DashboardProjectNotFoundError extends Error {
  constructor(readonly projectId: string) {
    super(`Unknown Project ${projectId}`);
    this.name = "DashboardProjectNotFoundError";
  }
}

export class DashboardIdempotencyConflictError extends Error {
  constructor() {
    super("Dashboard creation key is already bound to another configuration");
    this.name = "DashboardIdempotencyConflictError";
  }
}

export class DashboardRevisionConflictError extends Error {
  constructor(readonly dashboardId: string) {
    super(`Dashboard ${dashboardId} revision changed`);
    this.name = "DashboardRevisionConflictError";
  }
}
