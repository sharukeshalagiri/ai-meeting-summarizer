import { NavLink, Outlet } from "react-router-dom";

const NAV = [
  { to: "/", label: "Meetings", end: true },
  { to: "/analytics", label: "Analytics", end: false },
  { to: "/tasks", label: "Tasks", end: false },
  { to: "/ask", label: "Ask AI", end: false },
];

/**
 * App shell: one header and nav for every page, so navigation does not
 * shift between routes.
 */
function Layout() {
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
          </div>
        </div>
      </header>

      <main id="main">
        <Outlet />
      </main>
    </div>
  );
}

export default Layout;
