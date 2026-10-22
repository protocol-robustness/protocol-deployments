export interface Pro95ProfileValidation {
  valid: boolean;
  errors: string[];
}

type Obj = Record<string, any>;

function isObject(value: unknown): value is Obj {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validate the non-executable, demonstration-only PRO-95 intake profile. */
export function validatePro95DemoProfile(input: unknown): Pro95ProfileValidation {
  const errors: string[] = [];
  if (!isObject(input)) return { valid: false, errors: ['profile must be an object'] };
  const p = input;
  if (p.schema !== 'protocol-deployments.pro-95-demo-profile.v1') errors.push('schema identity mismatch');
  if (p.classification !== 'demonstration-only-not-pre-mainnet-release') errors.push('demo-only classification is required');
  if (p.profileId !== 'prf/pro-95/base-sepolia-demonstration') errors.push('profile identity mismatch');
  if (p.network?.chainId !== 84532 || p.network?.name !== 'Base Sepolia' || p.network?.kind !== 'testnet') errors.push('network must be Base Sepolia chain 84532');
  if (p.readiness?.status !== 'blocked' || p.readiness?.deploymentEnabled !== false || p.readiness?.operationEnabled !== false || p.readiness?.broadcastAllowed !== false || p.readiness?.qualification !== 'not-run-public-chain-not-qualified') errors.push('deployment, operation, and broadcast must remain disabled while unqualified');
  if (p.asset?.kind !== 'circle-issued-base-sepolia-testnet-usdc' || p.asset?.name !== 'USDC' || p.asset?.symbol !== 'USDC' || p.asset?.address !== '0x036CbD53842c5426634e7929541eC2318f3dCF7e' || p.asset?.chainId !== 84532 || p.asset?.decimals !== 6 || p.asset?.mintingByDemo !== false || p.asset?.mainnetRedeemable !== false) errors.push('asset must be the approved Circle Base Sepolia test USDC, 6 decimals, with demo minting disabled');

  const s = p.controlledScenario;
  if (!isObject(s) || !isObject(s.requests) || !isObject(s.fundedAllocations) || !isObject(s.claimantWithdrawals)) {
    errors.push('scenario maps are missing');
  } else {
    const sum = (v: Obj) => Object.values(v).reduce<number>((n, x) => n + (typeof x === 'number' && Number.isFinite(x) ? x : Number.NaN), 0);
    if (s.unit !== 'USDC base units (6 decimals)' || sum(s.requests) !== s.totalRequested || s.totalRequested !== 100000000 || JSON.stringify(s.requests) !== JSON.stringify({ alice: 50000000, bob: 30000000, carol: 20000000 })) errors.push('requests must be 50 / 30 / 20 USDC in 6-decimal base units');
    if (s.deposit !== 80000000 || s.restrictedRefundableReserve !== 10000000 || s.availableForAllocation !== 70000000 || s.deposit !== s.restrictedRefundableReserve + s.availableForAllocation) errors.push('deposit / protected / available USDC conservation mismatch');
    if (sum(s.fundedAllocations) !== s.totalFunded || s.totalFunded !== 70000000) errors.push('funded allocation total must equal 70 USDC');
    if (JSON.stringify(s.fundedAllocations) !== JSON.stringify({ alice: 35000000, bob: 21000000, carol: 14000000 })) errors.push('claimant allocations must be 35 / 21 / 14 USDC base units');
    if (sum(s.claimantWithdrawals) !== s.totalFunded || JSON.stringify(s.claimantWithdrawals) !== JSON.stringify(s.fundedAllocations)) errors.push('withdrawals must reconcile to funded claimant entitlements');
    if (s.totalUnmetRequests !== s.totalRequested - s.availableForAllocation || s.totalUnmetRequests !== 30000000 || s.unmetRequestsAreRecognizedLiabilities !== false) errors.push('30 USDC unmet requests must remain distinct from claimant liabilities');
    if (s.separateRestrictedRefund?.beneficiary !== 'carol' || s.separateRestrictedRefund?.amount !== 10000000 || s.expectedFundedClaimantLiabilityAfterWithdrawals !== 0 || s.displayAmountsUSDC?.deposit !== '80' || s.displayAmountsUSDC?.totalUnmetRequests !== '30') errors.push('restricted refund, displayed units and claimant-liability closure must be separate and exact');
  }

  const roots = p.canonicalRoots;
  if (!isObject(roots) || !['protocolGenesisRoot', 'initialConfigurationRoot', 'authorityStateRoot'].every((k) => typeof roots[k] === 'string' && /^sha256:[0-9a-f]{64}$/.test(roots[k]))) errors.push('candidate canonical roots must be exact SHA-256 references');
  if (roots?.protocolGenesisRoot !== 'sha256:668bc1d132b8745a3f6db7fa0b2dad2b85a11246e00c39e7b24d266af4724775' || roots?.initialConfigurationRoot !== 'sha256:f36913f0fb319e80aee3a1b795bd31a94486d08d51aa27df825277050e4768cb' || roots?.authorityStateRoot !== 'sha256:36a912294511057638de9d8a155f0a659413a3e242ca6bc76c877d5e3d6eb1a2') errors.push('candidate root values differ from the retained canonical derivations');
  if (roots?.chainInstanceGenesisRoot !== null || !String(roots?.derivation ?? '').includes('candidate')) errors.push('chain-instance root must remain absent until deployment identities exist');
  if (p.proof?.baseBoundProofStatus !== 'not-generated' || p.proof?.programId !== 'source-bound-entitlement-controlled-sp1-program.v1' || p.proof?.vkey !== '0x00691e1cff8e4252731c8fe2bc326e8725ed5f9b92a298cc30a2c5fc40962dd1' || p.proof?.elfSha256 !== '0x705efd1c5b997ae1f2c19eddcf6bb66a147e94b6b3b036393d6dab041c00542d' || p.proof?.publicValuesSchema !== 'prf/source-bound-entitlement-public-values.v1' || p.proof?.publicValuesLengthBytes !== 288 || p.sourceEvidence?.localQualificationIsBaseEvidence !== false) errors.push('local proof identity or evidence limits differ from the retained V3 record');
  if (p.asset?.sourceParityEvidence !== 'config/pro-rata-v2-entitlement/circle-base-sepolia-usdc-source-parity.v1.json' || p.asset?.aaveBaseSepoliaReference?.pool !== '0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27' || !p.asset?.aaveBaseSepoliaReference?.scope?.includes('does not supply to or integrate Aave')) errors.push('USDC source-parity or Aave cross-reference is missing or overclaims integration');
  if (p.authority?.roles?.includes('synthetic-token-mint-authority') || p.authority?.deployer !== '0xdd82cceb1d515f2e4fb0432fb5d53138813945d4' || p.authority?.ethBalanceAtRecordedObservationWei !== '0' || !p.authority?.keyStorage?.includes('no private key material is recorded')) errors.push('test-only deployer identity/custody boundary is missing or unsafe');
  const expectedRecipients = { alice: '0x8bdd01c7dead0abe3e855b458b820d9d727bccbf', bob: '0x867caab852f942ff80b6409109f1db76d4ecb36b', carol: '0xa57f019d83d1fbbc48500047ba27d21523fe55a8' };
  if (JSON.stringify(p.recipients && { alice: p.recipients.alice, bob: p.recipients.bob, carol: p.recipients.carol }) !== JSON.stringify(expectedRecipients)) errors.push('recipient addresses differ from the approved pseudonymous demo map');
  if (p.trustBoundary?.finalityClaim !== 'none' || p.trustBoundary?.sameBlockConcurrencyClaim !== false || p.trustBoundary?.sourceAuthentication !== 'not-performed-for-modelled-inputs') errors.push('trust and qualification limits are required');
  if (p.deploymentPackage?.status !== 'not-available-for-exact-v3-composition' || p.deploymentPackage?.pinnedArtifactBundle !== null || p.deploymentPackage?.deploymentPlan !== null) errors.push('exact V3 artifacts and plan must not be presented as available');
  if (p.transactionPolicy?.transactionCountMaximum !== null || p.transactionPolicy?.ethSpendCapWei !== null || p.transactionPolicy?.signing !== 'not-authorized-by-this-profile' || p.transactionPolicy?.broadcast !== 'not-authorized-by-this-profile') errors.push('no transaction caps or signing/broadcast authority may be implied');
  if (!Array.isArray(p.unresolvedDependencies) || p.unresolvedDependencies.length < 7) errors.push('unresolved dependencies must remain explicit');

  return { valid: errors.length === 0, errors };
}
