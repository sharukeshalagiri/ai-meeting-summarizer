import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import * as userRepo from "../../repositories/user.repository";
import { verifyCredentials } from "../../services/auth/auth.service";

/**
 * passport with the local (email + password) strategy.
 *
 * Only the user id goes into the session; each request re-reads the
 * user, so a deleted account stops working at once. passport 0.6+
 * regenerates the session on login (no session fixation) and on logout.
 */

let configured = false;

export const configurePassport = (): typeof passport => {
  if (configured) return passport;
  configured = true;

  passport.use(
    new LocalStrategy(
      { usernameField: "email", passwordField: "password", passReqToCallback: true },
      (req, email, password, done) => {
        verifyCredentials(email, password, req.ip ?? "unknown")
          .then((user) => done(null, user ?? false))
          .catch((error) => done(error));
      }
    )
  );

  passport.serializeUser((user, done) => done(null, user.id));

  passport.deserializeUser((id: unknown, done) => {
    if (typeof id !== "string") return done(null, false);

    userRepo
      .findById(id)
      .then((user) =>
        done(null, user ? { id: user.id, name: user.name, email: user.email } : false)
      )
      .catch((error) => done(error));
  });

  return passport;
};
