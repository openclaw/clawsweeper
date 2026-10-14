export class ValidationRecoveryRequiredError extends Error {
  readonly recoveryPaths = new Set<string>();
  private readonly detail: string;

  constructor(message: string, cause: unknown, paths: readonly string[] = []) {
    super(message, { cause });
    this.name = "ValidationRecoveryRequiredError";
    this.detail = message;
    this.retain(paths);
  }

  retain(paths: readonly string[]) {
    for (const path of paths) this.recoveryPaths.add(path);
    this.message = `${this.detail}. Validation recovery required: stop and verify all target processes have exited before inspecting or restoring retained state; do not retry this checkout.${
      this.recoveryPaths.size ? ` Retained paths: ${[...this.recoveryPaths].join(", ")}` : ""
    }`;
    return this;
  }
}

export function validationRecoveryRequired(error: unknown): ValidationRecoveryRequiredError | null {
  const visited = new Set<unknown>();
  while (error instanceof Error && !visited.has(error)) {
    if (error instanceof ValidationRecoveryRequiredError) return error;
    visited.add(error);
    error = error.cause;
  }
  return null;
}
