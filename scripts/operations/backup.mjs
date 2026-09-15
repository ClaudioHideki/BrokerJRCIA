import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  open,
  mkdir,
  readFile,
  writeFile,
  unlink,
  stat,
} from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
const MAGIC = Buffer.from("JRCBK1");
function key(value) {
  const bytes = Buffer.from(value ?? "", "base64");
  if (bytes.length !== 32 || bytes.toString("base64") !== value)
    throw new Error(
      "JRC_BACKUP_KEY must be exactly 32 bytes encoded as base64",
    );
  return bytes;
}
export async function encryptBackup(source, path, serializedKey) {
  const secret = key(serializedKey),
    nonce = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", secret, nonce),
    header = Buffer.concat([MAGIC, nonce]);
  cipher.setAAD(header);
  const target = await open(path, "wx", 0o600);
  let complete = false;
  source.once("error", (error) => cipher.destroy(error));
  try {
    const stream = Readable.from(
      (async function* () {
        yield header;
        for await (const chunk of source.pipe(cipher)) yield chunk;
        yield cipher.getAuthTag();
      })(),
    );
    await pipeline(
      stream,
      createWriteStream(path, { fd: target.fd, autoClose: false }),
    );
    complete = true;
  } finally {
    await target.close().catch((error) => {
      if (error.code !== "EBADF") throw error;
    });
    if (!complete) await unlink(path).catch(() => {});
  }
}
export async function decryptBackup(path, output, serializedKey) {
  const secret = key(serializedKey),
    info = await stat(path);
  if (info.size < 34) throw new Error("BACKUP_AUTHENTICATION_FAILED");
  const input = await open(path, "r"),
    header = Buffer.alloc(18),
    tag = Buffer.alloc(16);
  try {
    await input.read(header, 0, 18, 0);
    await input.read(tag, 0, 16, info.size - 16);
  } finally {
    await input.close();
  }
  if (!header.subarray(0, 6).equals(MAGIC))
    throw new Error("BACKUP_AUTHENTICATION_FAILED");
  const decipher = createDecipheriv("aes-256-gcm", secret, header.subarray(6));
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  const target = output ? await open(output, "wx", 0o600) : undefined;
  let complete = false;
  try {
    await pipeline(
      createReadStream(path, { start: 18, end: info.size - 17 }),
      decipher,
      target
        ? createWriteStream(output, { fd: target.fd, autoClose: false })
        : new Writable({
            write(_chunk, _encoding, done) {
              done();
            },
          }),
    );
    complete = true;
  } catch {
    throw new Error("BACKUP_AUTHENTICATION_FAILED");
  } finally {
    await target?.close().catch((error) => {
      if (error.code !== "EBADF") throw error;
    });
    if (target && !complete) await unlink(output).catch(() => {});
  }
}
async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function main() {
  const [mode, ...args] = process.argv.slice(2),
    secret = process.env.JRC_BACKUP_KEY;
  key(secret);
  if (mode === "decrypt") {
    if (args.length !== 2)
      throw new Error("Usage: decrypt encrypted-file new-output-file");
    await decryptBackup(resolve(args[0]), resolve(args[1]), secret);
    return;
  }
  if (mode === "verify") {
    const directory = resolve(args[0] ?? "");
    const manifest = JSON.parse(
      await readFile(join(directory, "manifest.json"), "utf8"),
    );
    if (
      manifest.version !== 1 ||
      !Array.isArray(manifest.files) ||
      manifest.files.length !== 5 ||
      new Set(manifest.files.map((f) => f.name)).size !== 5
    )
      throw new Error("INVALID_BACKUP_MANIFEST");
    for (const file of manifest.files) {
      if (
        ![
          "roles.sql.jrcbak",
          "broker.dump.jrcbak",
          "engine.dump.jrcbak",
          "engine-files.tar.gz.jrcbak",
          "runtime.env.jrcbak",
        ].includes(file.name) ||
        (await digest(join(directory, file.name))) !== file.sha256
      )
        throw new Error("BACKUP_CHECKSUM_FAILED");
      await decryptBackup(join(directory, file.name), undefined, secret);
    }
    process.stdout.write("Backup authentication and checksums verified.\n");
    return;
  }
  if (mode !== "backup" || args.length !== 3)
    throw new Error(
      "Usage: backup compose-file runtime-env-file new-backup-directory",
    );
  const [compose, envFile, directory] = args.map((value) => resolve(value));
  await mkdir(directory, { mode: 0o700 });
  const files = [];
  for (const [name, service, command] of [
    [
      "roles.sql",
      "postgres",
      ["pg_dumpall", "-U", "postgres", "--globals-only"],
    ],
    [
      "broker.dump",
      "postgres",
      ["pg_dump", "-U", "postgres", "-Fc", "jrc_broker"],
    ],
    [
      "engine.dump",
      "postgres",
      ["pg_dump", "-U", "postgres", "-Fc", "jrc_evolution"],
    ],
    [
      "engine-files.tar.gz",
      "evolution",
      ["tar", "-czf", "-", "-C", "/evolution/instances", "."],
    ],
  ]) {
    const child = spawn(
      "docker",
      [
        "compose",
        "--env-file",
        envFile,
        "-f",
        compose,
        "exec",
        "-T",
        service,
        ...command,
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    // A failed command never produces a complete manifest. Do not echo database diagnostics or secrets.
    child.stderr.resume();
    const finished = new Promise((accept, reject) => {
      child.once("error", () => reject(new Error("BACKUP_COMMAND_FAILED")));
      child.once("close", (code) =>
        code === 0 ? accept() : reject(new Error("BACKUP_COMMAND_FAILED")),
      );
    });
    const destination = join(directory, name + ".jrcbak");
    await Promise.all([
      encryptBackup(child.stdout, destination, secret),
      finished,
    ]);
    files.push({ name: name + ".jrcbak", sha256: await digest(destination) });
  }
  const destination = join(directory, "runtime.env.jrcbak");
  await encryptBackup(createReadStream(envFile), destination, secret);
  files.push({ name: "runtime.env.jrcbak", sha256: await digest(destination) });
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify(
      { version: 1, createdAt: new Date().toISOString(), files },
      null,
      2,
    ) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  process.stdout.write(
    "Encrypted PostgreSQL and runtime configuration backup completed.\n",
  );
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  main().catch((error) => {
    process.stderr.write(
      (error instanceof Error ? error.message : "BACKUP_FAILED") + "\n",
    );
    process.exitCode = 1;
  });
