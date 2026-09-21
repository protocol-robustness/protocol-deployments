import { ConfigError } from '../errors';

/**
 * Standalone validation helpers used both at resolution time and (in later
 * phases) at execution time.
 */

/**
 * Reject when the configured chain id differs from the connected RPC chain id.
 * Phase 1 cannot check a live RPC; the execution layer (Phase 3) calls this
 * immediately before any transaction. It is also used to reject a missing or
 * invalid configured binding.
 */
export function assertChainIdMatches(
  configured: { chainId: number; environment: string },
  connectedChainId: number | null | undefined,
): void {
  if (configured.chainId <= 0 || !Number.isInteger(configured.chainId)) {
    throw new ConfigError('UNRESOLVED_CHAIN_BINDING', `Invalid configured chainId ${configured.chainId} for environment '${configured.environment}'`);
  }
  if (connectedChainId == null) {
    throw new ConfigError('CHAIN_ID_MISMATCH', `No connected RPC chain id to compare against for environment '${configured.environment}'`);
  }
  if (configured.chainId !== connectedChainId) {
    throw new ConfigError(
      'CHAIN_ID_MISMATCH',
      `Configured chain id ${configured.chainId} differs from connected RPC chain id ${connectedChainId}`,
      { details: { configured: configured.chainId, connected: connectedChainId } },
    );
  }
}
