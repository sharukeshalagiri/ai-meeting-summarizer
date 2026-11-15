import { Navigate, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { AuthProvider } from "../lib/auth/AuthProvider";
import { useAuth } from "../lib/auth/authContext";
import { Skeleton } from "./Skeleton";
import "./account/account.css";

const NAV = [
  { to: "/", label: "Meetings", end: true },
  { to: "/analytics", label: "Analytics", end: false },
  { to: "/tasks", label: "Tasks", end: false },
  { to: "/prep", label: "Prep", end: false },
  { to: "/ask", label: "Ask AI", end: false },
];

/** Pages reachable without an account. */
const PUBLIC_PATHS = new Set(["/login"]);

/**
 * App shell: one header and nav for every page, so navigation does not
 * shift between routes. It is also the sign-in gate (w4-acct): every
 * page except /login needs an account, and an expired session sends
 * the user to /login, then back where they were.
 */
function Shell() {
  const { account, signOut } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const isPublic = PUBLIC_PATHS.has(location.pathname);

  if (account === undefined) {
    return (
      <main id="main" className="page">
        <Skeleton rows={2} />
      </main>
    );
  }

  if (!account && !isPublic) {
    const next = `${location.pathname}${location.search}`;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }

  if (isPublic) {
    return (
      <main id="main">
        <Outlet />
      </main>
    );
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <header className="app-header">
        <div className="app-header-inner">
          <NavLink to="/" className="brand" end>
            <span className="brand-mark" aria-hidden="true" />
            <span>Meeting&nbsp;AI</span>
          </NavLink>

          <nav aria-label="Main">
            <ul className="nav">
              {NAV.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.end}
                    className={({ isActive }) =>
                      `nav-link ${isActive ? "is-active" : ""}`
                    }
                  >
                    {item.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>

          <div className="header-actions">
            <NavLink to="/live" className="btn-link">
              <button type="button" className="secondary sm">
                Go live
              </button>
            </NavLink>

            <NavLink to="/new" className="btn-link">
              <button type="button" className="sm">
                Upload
              </button>
            </NavLink>

            <details className="account-menu">
              <summary className="nav-link" aria-label="Account">
                {account?.displayName || account?.name}
              </summary>
              <div className="account-menu-panel card">
                <p className="muted tiny">{account?.email}</p>
                <NavLink to="/settings" className="nav-link">Settings</NavLink>
                <NavLink to="/devices" className="nav-link">Devices</NavLink>
                <button
                  type="button"
                  className="secondary sm"
                  onClick={() => void signOut().then(() => navigate("/login"))}
                >
                  Sign out
                </button>
              </div>
            </details>
          </div>
        </div>
      </header>

      <main id="main">
        <Outlet />
      </main>
    </div>
  );
}

function Layout() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}

export default Layout;
