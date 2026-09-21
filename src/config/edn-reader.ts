import { ConfigError } from '../errors';

/**
 * A small, self-contained EDN reader for configuration files.
 *
 * EDN here is declarative configuration/architectural intent. We parse it into
 * plain JSON-serializable JS data — it is never evaluated as code. The reader
 * deliberately:
 *   - rejects duplicate map keys (a required safety check),
 *   - maps keywords to strings ("sew/escrow-vault"),
 *   - maps sets to arrays, bigints to JS bigint,
 *   - rejects unknown/unsupported constructs loudly.
 */

export type EdnValue =
  | string
  | number
  | bigint
  | boolean
  | null
  | EdnValue[]
  | { [k: string]: EdnValue };

class EdnReader {
  private pos = 0;
  constructor(
    private readonly src: string,
    private readonly label: string,
  ) {}

  private err(msg: string): never {
    throw new ConfigError('EDN_PARSE_FAILED', `EDN parse error in ${this.label} at offset ${this.pos}: ${msg}`);
  }

  private peek(): string {
    return this.src[this.pos] ?? '';
  }

  private skipWs(): void {
    while (this.pos < this.src.length) {
      const c = this.src[this.pos]!;
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
        this.pos++;
      } else if (c === ';') {
        while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos++;
      } else {
        break;
      }
    }
  }

  parse(): EdnValue {
    this.skipWs();
    const v = this.parseValue();
    this.skipWs();
    if (this.pos < this.src.length) {
      this.err(`unexpected trailing content at '${this.src.slice(this.pos, this.pos + 20)}'`);
    }
    return v;
  }

  private parseValue(): EdnValue {
    this.skipWs();
    const c = this.peek();
    if (c === '') this.err('unexpected end of input');
    if (c === '{') return this.parseMap();
    if (c === '[') return this.parseSeq(']');
    if (c === '(') return this.parseSeq(')');
    if (c === '#' && this.src[this.pos + 1] === '{') return this.parseSet();
    if (c === '"') return this.parseString();
    return this.parseAtom();
  }

  private parseMap(): EdnValue {
    this.pos++; // '{'
    const out: { [k: string]: EdnValue } = {};
    const seen = new Set<string>();
    this.skipWs();
    while (this.peek() !== '}') {
      if (this.pos >= this.src.length) this.err('unterminated map');
      const k = this.parseValue();
      const key = this.keyOf(k);
      if (seen.has(key)) {
        throw new ConfigError(
          'DUPLICATE_LOGICAL_ID',
          `Duplicate key in map in ${this.label}: '${key}'`,
        );
      }
      seen.add(key);
      this.skipWs();
      const v = this.parseValue();
      out[key] = v;
      this.skipWs();
    }
    this.pos++; // '}'
    return out;
  }

  private parseSeq(close: string): EdnValue {
    this.pos++; // opening
    const out: EdnValue[] = [];
    this.skipWs();
    while (this.peek() !== close) {
      if (this.pos >= this.src.length) this.err(`unterminated ${close}`);
      out.push(this.parseValue());
      this.skipWs();
    }
    this.pos++; // closing
    return out;
  }

  private parseSet(): EdnValue {
    this.pos += 2; // '#{'
    const out: EdnValue[] = [];
    this.skipWs();
    while (this.peek() !== '}') {
      if (this.pos >= this.src.length) this.err('unterminated set');
      out.push(this.parseValue());
      this.skipWs();
    }
    this.pos++;
    return out;
  }

  private parseString(): string {
    this.pos++; // '"'
    let out = '';
    while (true) {
      if (this.pos >= this.src.length) this.err('unterminated string');
      const c = this.src[this.pos]!;
      if (c === '"') {
        this.pos++;
        return out;
      }
      if (c === '\\') {
        const n = this.src[this.pos + 1];
        const escapes: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' };
        if (n === 'u') {
          const hex = this.src.slice(this.pos + 2, this.pos + 6);
          out += String.fromCharCode(parseInt(hex, 16));
          this.pos += 6;
          continue;
        }
        if (n && escapes[n] !== undefined) {
          out += escapes[n]!;
          this.pos += 2;
          continue;
        }
        this.err(`invalid escape '\\${n}'`);
      }
      out += c;
      this.pos++;
    }
  }

  private keyOf(v: EdnValue): string {
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return String(v);
    if (typeof v === 'bigint') return v.toString();
    if (v === null) return 'nil';
    if (typeof v === 'boolean') return String(v);
    this.err('map keys must be simple (string/number/boolean/nil)');
  }

  private parseAtom(): EdnValue {
    let start = this.pos;
    while (this.pos < this.src.length && !'{}[]()#",; \t\r\n'.includes(this.src[this.pos]!)) {
      this.pos++;
    }
    const token = this.src.slice(start, this.pos);
    if (token === '') this.err(`unexpected character '${this.peek()}'`);

    // nil / booleans
    if (token === 'nil') return null;
    if (token === 'true') return true;
    if (token === 'false') return false;

    // string? (not expected here)
    if (token.startsWith('"')) this.err('unexpected string token');

    // tagged literal rejection (other than set, handled earlier)
    if (token.startsWith('#')) {
      this.err(`unsupported tagged literal '${token}'`);
    }

    // keyword :foo or :ns/foo
    if (token.startsWith(':')) {
      const kw = token.slice(1);
      if (kw === '') this.err('empty keyword');
      return kw;
    }

    // bigint with N suffix
    if (/^-?\d+N$/.test(token)) {
      return BigInt(token.slice(0, -1));
    }

    // integer / float
    if (/^-?\d+$/.test(token)) return parseInt(token, 10);
    if (/^-?\d*\.\d+$/.test(token) || /^-?\d+[eE][+-]?\d+$/.test(token)) {
      return parseFloat(token);
    }

    // symbol or bare token: treat as string (used sparingly, e.g. package names)
    return token;
  }
}

export function parseEdn(input: string, label: string): EdnValue {
  const reader = new EdnReader(input, label);
  return reader.parse();
}
