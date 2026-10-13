const opaqueId = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,255})$/;
const integer = (value, minimum) => Number.isSafeInteger(value) && value >= minimum;
const object = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

// This is a denial workflow, not a filesystem authorizer. The trusted caller must
// opt in independently; display codes and absent summaries prove no containment.
export function createPermissionDenialPolicy({ requiredWorkflowAuthority } = {}) {
  if (typeof requiredWorkflowAuthority !== 'string' || !requiredWorkflowAuthority.trim())
    throw new TypeError('Permission denial requires an independent workflow authority.');

  return function resolvedUnscopedReadDenial(pending, operation, grant, policy) {
    if (
      policy?.unscopedReadPermission !== 'reject' ||
      policy?.unscopedReadPermissionAuthority !== requiredWorkflowAuthority ||
      !object(operation) ||
      typeof operation.operationId !== 'string' ||
      !opaqueId.test(operation.operationId) ||
      typeof operation.conversationId !== 'string' ||
      !opaqueId.test(operation.conversationId) ||
      !integer(operation.generation, 1) ||
      !integer(operation.version, 1) ||
      operation.executionState !== 'waiting_for_user' ||
      !object(pending) ||
      pending.kind !== 'permission' ||
      pending.state !== 'live_pending' ||
      pending.operationId !== operation.operationId ||
      pending.generation !== operation.generation ||
      pending.operationVersion !== operation.version ||
      typeof pending.hostRequestId !== 'string' ||
      !opaqueId.test(pending.hostRequestId) ||
      !object(grant) ||
      grant.conversationId !== operation.conversationId ||
      !integer(grant.version, 0) ||
      !Array.isArray(grant.permissionChoices) ||
      !grant.permissionChoices.includes('reject') ||
      !object(pending.content) ||
      Object.keys(pending.content).length !== 2 ||
      !Object.hasOwn(pending.content, 'actionCode') ||
      !Object.hasOwn(pending.content, 'resourceCode') ||
      'targetSummary' in pending.content ||
      pending.content.actionCode !== 'read' ||
      pending.content.resourceCode !== 'workspace_resource'
    )
      return null;

    return {
      choice: 'reject',
      authority: requiredWorkflowAuthority,
      reason: 'unscoped_read_has_no_target_summary',
      targetScope: 'unknown',
      containmentProven: false,
    };
  };
}
