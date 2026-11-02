const fs = require("node:fs");
const path = require("node:path");
const control = path.join(process.env.SETUP_FIXTURE_ROOT, "control");
const read = (name, fallback = "") => {
  try {
    return fs.readFileSync(path.join(control, name), "utf8");
  } catch {
    return fallback;
  }
};
const finish = () => {
  fs.writeFileSync(path.join(control, "busy"), "0");
  process.exit(0);
};
let ending = false;
setTimeout(
  () => fs.writeFileSync(path.join(control, "busy"), "6"),
  Number(read("startup-delay", "10"))
);
setInterval(() => {
  if (fs.existsSync(path.join(control, "stop")) && !ending) {
    ending = true;
    setTimeout(finish, Number(read("shutdown-delay", "10")));
  }
}, 10);
process.on("SIGTERM", finish);
