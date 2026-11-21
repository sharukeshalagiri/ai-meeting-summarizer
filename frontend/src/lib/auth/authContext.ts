import { createContext, useContext } from "react";
import type { Account } from "../../types/account";

export interface AuthState {
  /** null while signed out; undefined while the first check runs. */
  account: Account | null | undefined;
  signupEnabled: boolean;
  /** Re-reads /auth/me (after sign-in, or a settings change). */
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

export const AuthContext = createContext<AuthState | null>(null);

export const useAuth = (): AuthState => {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside <AuthProvider>");
  return value;
};
