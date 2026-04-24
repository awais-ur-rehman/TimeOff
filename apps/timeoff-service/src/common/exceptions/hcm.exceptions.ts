export class HcmUnavailableException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HcmUnavailableException';
  }
}

export class HcmBalanceInsufficientException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HcmBalanceInsufficientException';
  }
}
