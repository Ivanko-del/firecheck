export class RulesSyntaxError extends Error {
    offset;
    constructor(message, offset) {
        super(message);
        this.offset = offset;
        this.name = 'RulesSyntaxError';
    }
}
