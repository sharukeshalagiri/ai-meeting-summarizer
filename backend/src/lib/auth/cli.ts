/**
 * Sets (or resets) the password of an account, creating it with --name
 * if it does not exist. The way to give the existing development user a
 * password once accounts are on, and the only way to create one when
 * sign-up is off (production).
 *
 *   npm --prefix backend run user:password -- --email me@example.com
 *   npm --prefix backend run user:password -- --email me@example.com --name "Me"
 *   npm --prefix backend run user:password -- --list
 *
 * In the production image (compiled, no ts-node):
 *   docker compose ... exec backend node dist/lib/auth/cli.js --email me@example.com
 *
 * The password is read from a hidden prompt, or from stdin when piped
 * (echo "$PW" | npm ... ). It is never taken from the command line, so
 * it does not end up in shell history. Ends the user's sessions.
 */
import readline from "readline";
import { prisma } from "../prisma";
import { setPasswordFor } from "../../services/auth/auth.service";
import { MIN_PASSWORD_LENGTH } from "./password";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const readHidden = (question: string): Promise<string> =>
  new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const output = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    let asked = false;
    output._writeToOutput = (s: string) => {
      // Echo the question once, then nothing while typing.
      if (!asked) {
        output.output.write(s);
        asked = true;
      }
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });

const readPiped = async (): Promise<string> => {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data.replace(/\r?\n$/, "");
};

const main = async () => {
  if (args.includes("--list")) {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: "asc" },
      select: { email: true, name: true, passwordHash: true, _count: { select: { meetings: true } } },
    });
    for (const u of users) {
      console.log(`${u.email}\t${u.name}\tmeetings=${u._count.meetings}\tpassword=${u.passwordHash ? "set" : "none"}`);
    }
    return;
  }

  const email = flag("email");
  if (!email) {
    console.error("Usage: user:password -- --email <email> [--name <name>]   (or --list)");
    process.exitCode = 2;
    return;
  }

  let password: string;
  if (process.stdin.isTTY) {
    password = await readHidden(`New password for ${email} (min ${MIN_PASSWORD_LENGTH} chars): `);
    const again = await readHidden("Repeat it: ");
    if (password !== again) {
      console.error("The passwords do not match.");
      process.exitCode = 1;
      return;
    }
  } else {
    password = await readPiped();
  }

  const result = await setPasswordFor({ email, password, createName: flag("name") });
  console.log(result.created ? `Created ${email} with a password.` : `Password set for ${email}.`);
};

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
