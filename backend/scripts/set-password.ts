/**
 * `npm --prefix backend run user:password -- --email <email> [--name <name>]`
 *
 * Sets a password for an existing user (e.g. the development user that
 * existed before accounts), or creates the user with --name. The code
 * lives in src/lib/auth/cli.ts so the production image, which has no
 * ts-node, can run the compiled `node dist/lib/auth/cli.js`.
 */
import "../src/lib/auth/cli";
