import {it,expect} from 'vitest';
import {genericWorkspaceReportBundle} from '../scripts/package-generic-workspace-report.mjs';
import {parseGenericNapplet} from '../src/napplets/generic-protocol.js';
it('authors a separate portable aggregate app without changing v1',async()=>{const html=await genericWorkspaceReportBundle();const b=parseGenericNapplet(html,{napplet:{version:2,app_id:'workspace-report-generic',bindings:{summary:{workspace_id:'11111111-1111-4111-8111-111111111111'}}}});expect(b.capability).toBe('workspace-aggregate');expect(b.name).toBe('summary');expect(html).toContain("version:2,session");expect(html).toContain('d.version!==2');expect(html).not.toContain('src="app.js"');});
