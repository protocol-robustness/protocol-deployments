import { describe, it } from 'vitest';
import { resolveEdn, baseline, expectCode } from './helpers';

/**
 * Adversarial validation: every security-sensitive misconfiguration must be
 * rejected before any transaction can execute.
 */

describe('adversarial validation', () => {
  it('rejects unknown logical contract in overlay', () => {
    expectCode(
      {
        environment: baseline.environment.replace(
          ':deploymentOrder',
          ':overlays { :ghost/contract {:parameters {:x {:value 1}}} }\n :deploymentOrder',
        ),
      },
      'UNKNOWN_LOGICAL_CONTRACT',
    );
  });

  it('rejects unknown logical contract in deployment order', () => {
    expectCode(
      { environment: baseline.environment.replace(':sew/escrow', ':ghost/contract') },
      'UNKNOWN_LOGICAL_CONTRACT',
    );
  });

  it('rejects duplicate logical id in deployment order', () => {
    expectCode(
      { environment: baseline.environment.replace(':sew/escrow', ':shared/gov-token') },
      'DUPLICATE_LOGICAL_ID',
    );
  });

  it('rejects unknown artifact source', () => {
    expectCode(
      { architecture: baseline.architecture.replace(':artifactSource :sew/deployables', ':artifactSource :ghost/source') },
      'UNKNOWN_ARTIFACT_SOURCE',
    );
  });

  it('rejects unknown dependency (relationship target)', () => {
    expectCode(
      { architecture: baseline.architecture.replace(':dependsOn [:shared/timelock]', ':dependsOn [:ghost/contract]') },
      'UNKNOWN_DEPENDENCY',
    );
  });

  it('rejects dependency cycles', () => {
    // make escrow depend on governor and governor depend on escrow
    const arch = baseline.architecture
      .replace(':relationships {:dependsOn [:shared/timelock]}', ':relationships {:dependsOn [:shared/timelock :sew/escrow]}')
      .replace(':parameters {:rate', ':relationships {:dependsOn [:shared/governor]}\n :parameters {:rate');
    expectCode({ architecture: arch }, 'DEPENDENCY_CYCLE');
  });

  it('rejects artifact missing from pinned package', () => {
    expectCode(
      { architecture: baseline.architecture.replace(':artifact "EscrowVault"', ':artifact "GhostVault"') },
      'ARTIFACT_MISSING',
    );
  });

  it('rejects unknown governance group (unknown lane)', () => {
    expectCode(
      { governance: baseline.governance.replace(':lane :sew/lane', ':lane :ghost/lane') },
      'UNKNOWN_GOVERNANCE_GROUP',
    );
  });

  it('rejects unknown verifier profile', () => {
    expectCode(
      { verification: baseline.verification.replace(':verificationProfile :prf/profile', ':verificationProfile :prf/ghost') },
      'UNKNOWN_VERIFIER_PROFILE',
    );
  });

  it('rejects immutable parameter assigned runtime governance', () => {
    // add a governance operation targeting the immutable version param on prf/verifier
    const gov = baseline.governance.replace(
      ':operations { :gov/quorum {:target :shared/governor :parameter :quorum} }',
      ':operations { :gov/quorum {:target :shared/governor :parameter :quorum} :ver/version {:target :prf/verifier :parameter :version} }',
    );
    expectCode({ governance: gov }, 'IMMUTABLE_ASSIGNED_GOVERNANCE');
  });

  it('rejects governed parameter without authority', () => {
    // mark a param governed but do not add it to any group
    const arch = baseline.architecture.replace(':supply {:value 100N :mutability :immutable}', ':supply {:value 100N :mutability :governed}');
    expectCode({ architecture: arch }, 'GOVERNED_PARAM_NO_AUTHORITY');
  });

  it('rejects initial parameter outside configured constraint', () => {
    expectCode(
      { architecture: baseline.architecture.replace(':rate {:value 500N', ':rate {:value 5000N') },
      'PARAM_OUT_OF_CONSTRAINT',
    );
  });

  it('rejects unknown parameter targeted by governance operation', () => {
    const gov = baseline.governance.replace(':parameter :rate', ':parameter :doesNotExist');
    expectCode({ governance: gov }, 'UNKNOWN_PARAMETER');
  });

  it('rejects overlay for undeclared parameter', () => {
    expectCode(
      {
        environment: baseline.environment.replace(
          ':deploymentOrder',
          ':overlays { :sew/escrow {:parameters {:ghost {:value 1}}} }\n :deploymentOrder',
        ),
      },
      'UNKNOWN_PARAMETER',
    );
  });

  it('rejects unresolved deployment order (missing contract)', () => {
    expectCode(
      { environment: baseline.environment.replace(' :sew/escrow :prf/verifier ]', ' :prf/verifier ]') },
      'UNRESOLVED_DEPLOYMENT_ORDER',
    );
  });

  it('rejects dependency order violation (depends on later contract)', () => {
    const env = baseline.environment.replace(
      ':deploymentOrder [ :shared/gov-token :shared/timelock :shared/governor :sew/escrow :prf/verifier ]',
      ':deploymentOrder [ :shared/gov-token :shared/governor :shared/timelock :sew/escrow :prf/verifier ]',
    );
    // governor now at index 1 but dependsOn timelock at index 2 -> violation
    expectCode({ environment: env }, 'DEPENDENCY_ORDER_VIOLATION');
  });

  it('rejects empty deployment order', () => {
    expectCode(
      { environment: baseline.environment.replace('[ :shared/gov-token :shared/timelock :shared/governor :sew/escrow :prf/verifier ]', '[]') },
      'UNRESOLVED_DEPLOYMENT_ORDER',
    );
  });

  it('rejects invalid/zero chain id binding', () => {
    expectCode(
      { environment: baseline.environment.replace(':chainId 31337', ':chainId 0') },
      'UNRESOLVED_CHAIN_BINDING',
    );
  });
});
