import * as path from 'path';
import { loadConfig } from '../config/load';
import { executableDeploymentPrefix, readDeploymentUnitCatalog, readSuccessorDeploymentPlan, unsupportedDeploymentPrerequisite, validateArchitectureUnitOwnership, validatePlanAgainstUnits } from '../deployment/successor-plan';

const root = process.cwd();
const planPath = path.resolve(root, process.argv[2] ?? 'config/pro-rata-v2-entitlement/successor-fork.plan.v1.json');
const unitsPath = path.resolve(root, process.argv[3] ?? 'config/deployment-units.v1.json');
const plan = readSuccessorDeploymentPlan(planPath);
const units = readDeploymentUnitCatalog(unitsPath);
validatePlanAgainstUnits(plan, units);
const generic = loadConfig({ configDir: path.join(root, 'config') });
const successor = loadConfig({ configDir: path.join(root, 'config'), profileDir: path.join(root, 'config/pro-rata-v2-entitlement') });
validateArchitectureUnitOwnership(Object.keys(generic.architecture.contracts), units);
validateArchitectureUnitOwnership(Object.keys(successor.architecture.contracts), units);
const deploymentBlocker = unsupportedDeploymentPrerequisite(plan);
const executablePrefix = executableDeploymentPrefix(plan);
console.log(JSON.stringify({
  status: 'structurally-valid',
  execution: {
    freshDeployment: deploymentBlocker ? 'verified-prefix-available' : 'available',
    executablePrefixContracts: [...executablePrefix.contractIds],
    firstUnimplementedPrerequisite: deploymentBlocker?.stage,
  },
  planId: plan.planId,
  localOnly: plan.localOnly,
  selectedUnits: plan.selectedUnits,
  excludedUnits: plan.excludedUnits,
  selectedContracts: Object.keys(plan.contracts).length,
  stages: plan.stages.length,
  genericArchitectureContracts: Object.keys(generic.architecture.contracts).length,
  successorArchitectureContracts: Object.keys(successor.architecture.contracts).length,
}, null, 2));
