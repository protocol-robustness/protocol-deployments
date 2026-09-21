import * as fs from 'fs';
import * as path from 'path';
import { ConfigError } from '../errors';
import { parseEdn as parseEdnInternal, type EdnValue } from './edn-reader';

export type { EdnValue };

/** Parse an EDN string into plain JS data. Throws ConfigError on failure. */
export function parseEdn(input: string, label: string): EdnValue {
  return parseEdnInternal(input, label);
}

/** Read and parse an EDN file from disk. */
export function readEdnFile(filePath: string): EdnValue {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    throw new ConfigError('EDN_FILE_NOT_FOUND', `Cannot read EDN file ${filePath}`, {
      path: filePath,
      details: { cause: e instanceof Error ? e.message : String(e) },
    });
  }
  return parseEdn(text, path.basename(filePath));
}
