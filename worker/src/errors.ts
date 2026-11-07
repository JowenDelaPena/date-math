export class InputError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}
