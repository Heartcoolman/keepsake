// 授权闸门:必须保持为 index.ts 的第一个 import —— 其余模块在顶层读
// MOCK_AI / INFERENCE_DISABLED,须在它们求值前完成降级判定。
// 按 LICENSE(Elastic License 2.0)条款,禁止移动、修改、禁用或绕过本功能。
import { readFileSync } from 'node:fs';
import { verifyLicenseToken, type LicenseInfo } from './license.ts';

export let license: LicenseInfo | null = null;

function demote(message: string) {
  console.warn(
    `[license] ${message} — running in demo mode (AI mocked, inference disabled). ` +
      'Set NIANXIANG_LICENSE or provide a nianxiang.license file to unlock.',
  );
  process.env.MOCK_AI = '1';
  process.env.INFERENCE_DISABLED = '1';
}

let token = process.env.NIANXIANG_LICENSE?.trim() || null;
if (!token) {
  const candidates = process.env.NIANXIANG_LICENSE_FILE
    ? [process.env.NIANXIANG_LICENSE_FILE]
    : ['nianxiang.license', '../nianxiang.license'];
  for (const file of candidates) {
    try {
      token = readFileSync(file, 'utf8').trim();
      break;
    } catch {
      /* try next */
    }
  }
}

if (!token) {
  demote('no license found');
} else {
  const check = verifyLicenseToken(token);
  if (check.ok) license = check.info;
  else demote(`invalid license (${check.reason})`);
}
