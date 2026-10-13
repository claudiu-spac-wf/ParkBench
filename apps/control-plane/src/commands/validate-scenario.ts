import fs from "node:fs";
import { validateScenario } from "../../../../packages/contracts/src/validator";
const file = process.argv[2];
if (!file) throw new Error("scenario_file_required");
console.log(JSON.stringify(validateScenario(JSON.parse(fs.readFileSync(file, "utf8"))), null, 2));
