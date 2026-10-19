import * as fs from 'fs';
import * as path from 'path';
import { ConfigError } from '../errors';

/** Read the independently selected state-expectation package without allowing
 * the evidence producer to escape the caller-selected trust root. */
export function readCapitalFlowExpectations(root: string, relativeFile: string): unknown {
  const trustedRoot = path.resolve(root);
  const relative = path.normalize(relativeFile);
  if (!relativeFile || path.isAbsolute(relative) || relative === '.' || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new ConfigError('CAPITAL_FLOW_EXPECTATIONS_INVALID', 'Capital-flow expectations must be a relative file within the independently selected trusted-context root');
  }
  const file = path.resolve(trustedRoot, relative);
  const contained = path.relative(trustedRoot, file);
  if (!contained || contained === '..' || contained.startsWith(`..${path.sep}`) || path.isAbsolute(contained)) {
    throw new ConfigError('CAPITAL_FLOW_EXPECTATIONS_INVALID', 'Capital-flow expectations escape the trusted-context root');
  }
  try {
    const realRoot = fs.realpathSync(trustedRoot);
    const realFile = fs.realpathSync(file);
    const realRelative = path.relative(realRoot, realFile);
    if (!realRelative || realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative) || !fs.statSync(realFile).isFile()) {
      throw new Error('not a regular file within the trusted-context root');
    }
    return JSON.parse(fs.readFileSync(realFile, 'utf8')) as unknown;
  } catch {
    throw new ConfigError('CAPITAL_FLOW_EXPECTATIONS_INVALID', 'Capital-flow expectations are unavailable or cannot be resolved safely within the trusted-context root');
  }
}
