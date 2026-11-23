import '../../public/napplets/workspace-report/v1/model.js';
import { assertIdentity } from '../canvas/projection.js';
export const REPORT_MODEL = globalThis.WorkspaceReportModel;
export function normalizeWorkspaceReport(payload,context,range,{storage=false}={}) {
  assertIdentity(payload,context);
  const { identity, ...value }=payload;
  if(value.range!==range || value.channels?.length!==Math.min(10,value.ranking?.total_channels))throw Error('Workspace Report range or ranking mismatch.');
  return storage ? REPORT_MODEL.validateWithStorage(value) : REPORT_MODEL.validate(value);
}
