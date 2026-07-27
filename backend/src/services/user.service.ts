import { logger } from "../lib/logger";
import * as userRepo from "../repositories/user.repository";

const log = logger.child({ module: "user.service" });

export const listUsers = () => userRepo.findAll();

export const createUser = async (input: {
  name: string;
  email: string;
}) => {
  const user = await userRepo.create(input);

  log.info("User created", { userId: user.id });

  return user;
};
