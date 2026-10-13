import crypto from "node:crypto";
import { normalizeRunName } from "../../../../packages/contracts/src/matrix-expansion";

export function scheduleSlug(name: string): string {
  try {
    return normalizeRunName(name);
  } catch {
    throw new Error("schedule_name_invalid");
  }
}

export function allocateNameDerivedId(
  scheduleName: string,
  isTaken: (id: string) => boolean,
  randomStart: () => number = () => crypto.randomBytes(2).readUInt16BE(0)
): string {
  return allocateSuffix(scheduleSlug(scheduleName),isTaken,randomStart);
}
export function allocateNumberedRunId(scheduleName:string,runNumber:number,isTaken:(id:string)=>boolean,randomStart:()=>number=()=>crypto.randomBytes(2).readUInt16BE(0)):string {
  if(!Number.isSafeInteger(runNumber)||runNumber<=0)throw new Error("run_number_invalid");
  return allocateSuffix(`${scheduleSlug(scheduleName)}-${runNumber}`,isTaken,randomStart);
}
function allocateSuffix(slug:string,isTaken:(id:string)=>boolean,randomStart:()=>number):string {
  const start = randomStart();
  if (!Number.isInteger(start) || start < 0 || start > 0xffff)
    throw new Error("name_suffix_invalid");
  for (let offset = 0; offset < 0x10000; offset++) {
    const suffix = ((start + offset) & 0xffff).toString(16).padStart(4, "0");
    const id = `${slug}-${suffix}`;
    if (!isTaken(id)) return id;
  }
  throw new Error("name_suffix_exhausted");
}
