import { hash, verify } from "@node-rs/argon2";

/**
 * Password hashing (argon2id via @node-rs/argon2).
 *
 * The library defaults are the OWASP minimum for argon2id (19 MiB,
 * 2 iterations, 1 lane) and are encoded in the hash string, so they can
 * be raised later without invalidating stored hashes. @node-rs/argon2
 * ships prebuilt binaries (Windows, glibc and musl Linux), so neither
 * a developer machine nor the Docker image needs a C toolchain.
 */

export const MIN_PASSWORD_LENGTH = 10;
/** argon2 has no practical limit, but a huge body is just a DoS. */
export const MAX_PASSWORD_LENGTH = 256;

/** Null when acceptable; otherwise a user-facing reason. */
export const passwordProblem = (password: string): string | null => {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }

  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Use at most ${MAX_PASSWORD_LENGTH} characters.`;
  }

  return null;
};

export const hashPassword = (password: string): Promise<string> =>
  hash(password);

/**
 * A malformed stored hash counts as a mismatch rather than a 500: the
 * caller answers "wrong email or password" either way.
 */
export const verifyPassword = async (
  storedHash: string,
  password: string
): Promise<boolean> => {
  try {
    return await verify(storedHash, password);
  } catch {
    return false;
  }
};

/**
 * Verifying against this when the email is unknown keeps the response
 * time the same as for a wrong password, so timing does not reveal
 * which emails have accounts.
 */
let dummyHash: Promise<string> | null = null;
export const burnVerify = async (password: string): Promise<void> => {
  dummyHash ??= hash("not-a-real-password-for-timing-only");
  await verifyPassword(await dummyHash, password);
};
