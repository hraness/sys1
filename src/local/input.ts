/** Adapter input cannot fit without discarding decision evidence. */
export class LocalInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalInputError";
  }
}
