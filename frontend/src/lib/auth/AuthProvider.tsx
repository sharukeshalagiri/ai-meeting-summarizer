import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { AUTH_REQUIRED_EVENT } from "../../api/api";
import { fetchMe, logout } from "../../api/w4-acct";
import type { Account } from "../../types/w4-acct";
import { AuthContext, type AuthState } from "./authContext";

/**
 * Holds the signed-in account. The session itself is an httpOnly
 * cookie the page cannot read, so "am I signed in" is always asked of
 * the server (GET /auth/me). A 401 from any API call (expired session)
 * flips the state to signed out, and Layout sends the user to /login.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<Account | null | undefined>(undefined);
  const [signupEnabled, setSignupEnabled] = useState(false);

  const load = useCallback(
    () =>
      fetchMe().then(
        (me) => {
          setAccount(me.account);
          setSignupEnabled(me.signupEnabled);
        },
        (error) => {
          // Backend unreachable: treat as signed out; the login page says so.
          console.error(error);
          setAccount(null);
        }
      ),
    []
  );

  const refresh = useCallback(async () => {
    await load();
  }, [load]);

  const signOut = useCallback(async () => {
    try {
      await logout();
    } finally {
      setAccount(null);
    }
  }, []);

  useEffect(() => {
    void load();
    const onRequired = () => setAccount(null);
    window.addEventListener(AUTH_REQUIRED_EVENT, onRequired);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, onRequired);
  }, [load]);

  const value = useMemo<AuthState>(
    () => ({ account, signupEnabled, refresh, signOut }),
    [account, signupEnabled, refresh, signOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
