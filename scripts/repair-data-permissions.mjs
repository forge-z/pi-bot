import {
  closeSync,
  constants,
  fchmodSync,
  fchownSync,
  fstatSync,
  lstatSync,
  openSync,
} from "node:fs";

const data = "/app/data";
const files = [
  "config.yaml",
  "app.sqlite",
  "app.sqlite-journal",
  "app.sqlite-shm",
  "app.sqlite-wal",
];
const uid = 1000;
const gid = 1000;

function repair(path, directory = false) {
  let fd;
  try {
    if (!directory && !lstatSync(path).isFile()) return;
    fd = openSync(
      path,
      constants.O_RDONLY |
        constants.O_NOFOLLOW |
        (directory ? constants.O_DIRECTORY : constants.O_NONBLOCK),
    );
    const info = fstatSync(fd);
    if (!directory && (!info.isFile() || info.nlink !== 1)) return;
    const mode = info.mode & 0o777;
    const required = directory ? 0o700 : 0o600;
    const ownerChanged = info.uid !== uid || info.gid !== gid;
    if (ownerChanged) fchownSync(fd, uid, gid);
    if ((mode & required) !== required) fchmodSync(fd, mode | required);
    if (ownerChanged || (mode & required) !== required)
      console.log(`Pi-Bot: repaired permissions on ${path} for UID ${uid}.`);
  } catch (error) {
    if (!directory && (error.code === "ENOENT" || error.code === "ELOOP"))
      return;
    console.error(
      `Pi-Bot: cannot repair permissions on ${path} (${error.code ?? "I/O error"}).`,
    );
    process.exitCode = 1;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

repair(data, true);
if (!process.exitCode) {
  for (const file of files) repair(`${data}/${file}`);
}
