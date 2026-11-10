import { HashRouter, Link, NavLink, Route, Routes } from "react-router";
import { GITHUB, NAV_GROUPS } from "./components/Docs.js";
import { OverviewPage } from "./pages/OverviewPage.js";
import { InstallPage } from "./pages/InstallPage.js";
import { PresetsPage, QuickStartPage } from "./pages/GettingStartedPages.js";
import { ExpressPage } from "./pages/ExpressPage.js";
import { FrameworksPage } from "./pages/FrameworksPage.js";
import {
  AuthPage,
  AuthzPage,
  CmsPage,
  DatabasePage,
  InfraPage,
  SsoPage,
  TenancyPage,
} from "./pages/GuidesPages.js";
import {
  ArchitecturePage,
  DeploymentPage,
  NotFoundPage,
  RoadmapPage,
  SecurityPage,
} from "./pages/OperationsPages.js";

// HashRouter makes GitHub Pages project hosting work without server
// rewrites (routes live in the URL hash; Vite base handles asset paths).
// NOTE: HashRouter must NOT receive the /allinone basename — it would
// expect hashes like #/allinone/install instead of #/install.

function Layout() {
  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <Link className="brand" to="/">
            <span className="brand-mark">a1</span>
            <span>allinone docs</span>
          </Link>
          <nav aria-label="Primary">
            <NavLink to="/quickstart">Quick start</NavLink>
            <NavLink to="/database">Database</NavLink>
            <NavLink to="/auth">Auth</NavLink>
            <NavLink to="/security">Security</NavLink>
          </nav>
        </div>
      </header>

      <div className="layout">
        <aside className="sidebar" aria-label="Docs navigation">
          <h2>Documentation</h2>
          {NAV_GROUPS.map((group) => (
            <div key={group.group} className="sidebar-group">
              <div className="sidebar-group-title">{group.group}</div>
              <ul>
                {group.entries.map((entry) =>
                  entry.external ? (
                    <li key={entry.label}>
                      <a href={entry.external} target="_blank" rel="noreferrer">
                        {entry.label}
                      </a>
                    </li>
                  ) : (
                    <li key={entry.label}>
                      <NavLink
                        to={entry.to}
                        className={({ isActive }) => (isActive ? "active" : "")}
                      >
                        {entry.label}
                      </NavLink>
                    </li>
                  ),
                )}
              </ul>
            </div>
          ))}
        </aside>

        <main className="main">
          <Routes>
            <Route index element={<OverviewPage />} />
            <Route path="/install" element={<InstallPage />} />
            <Route path="/quickstart" element={<QuickStartPage />} />
            <Route path="/presets" element={<PresetsPage />} />
            <Route path="/express" element={<ExpressPage />} />
            <Route path="/frameworks" element={<FrameworksPage />} />
            <Route path="/architecture" element={<ArchitecturePage />} />
            <Route path="/database" element={<DatabasePage />} />
            <Route path="/tenancy" element={<TenancyPage />} />
            <Route path="/auth" element={<AuthPage />} />
            <Route path="/sso" element={<SsoPage />} />
            <Route path="/authz" element={<AuthzPage />} />
            <Route path="/cms" element={<CmsPage />} />
            <Route path="/infra" element={<InfraPage />} />
            <Route path="/security" element={<SecurityPage />} />
            <Route path="/deployment" element={<DeploymentPage />} />
            <Route path="/roadmap" element={<RoadmapPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </main>
      </div>

      <footer className="footer">
        <span>allinone — MIT</span>
        <span>
          Secure by default · Database-agnostic · Framework-native ·{" "}
          <a href={GITHUB} target="_blank" rel="noreferrer">
            GitHub
          </a>
        </span>
      </footer>
    </>
  );
}

export function App() {
  return (
    <HashRouter>
      <Layout />
    </HashRouter>
  );
}
