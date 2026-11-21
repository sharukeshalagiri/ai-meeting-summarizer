import * as userRepo from "../repositories/user.repository";
import { NotFound } from "../types/errors";

/**
 * GET /users answers with the signed-in user only: there is
 * no endpoint that lists other accounts. Accounts are created by
 * sign-up (POST /auth/signup) or the CLI (scripts/set-password.ts).
 */
export const listUsers = async (userId: string) => {
  const user = await userRepo.findById(userId);
  if (!user) throw NotFound("Account not found");
  return [user];
};
