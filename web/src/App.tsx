import { createContext, lazy, Suspense, useContext, useEffect, useState, type ReactNode } from "react";
import { CancelHost } from "./components/CancelEntry";
import { PinPrompt } from "./components/PinPrompt";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { api, getToken, setToken, setMediaToken } from "./lib/api";
import { ToastProvider, Loading } from "./components/ui";
import Layout from "./components/Layout";
import { LightboxHost } from "./components/Capture";
import { UpdateBanner } from "./components/UpdateBanner";
import Login from "./pages/Login"; // sign-in is the first screen an unauthenticated user needs — keep it eager
import { loadLookups } from "./lib/lookups";
import { loadProducts } from "./lib/format";
// every other page is code-split (React.lazy): the browser only downloads a screen's JS when it's first opened, so
// sign-in and first paint stay fast on the phones/tablets this PWA targets instead of pulling all ~60 pages up front.
const Help = lazy(() => import("./pages/Help"));
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Inbox = lazy(() => import("./pages/Inbox"));
const Customers = lazy(() => import("./pages/Customers"));
const Khata = lazy(() => import("./pages/Khata"));
const Orders = lazy(() => import("./pages/Orders"));
const Complaints = lazy(() => import("./pages/Complaints"));
const Campaigns = lazy(() => import("./pages/Campaigns"));
const Pos = lazy(() => import("./pages/Pos"));
const Shifts = lazy(() => import("./pages/Shifts"));
const Stock = lazy(() => import("./pages/Stock"));
const DipCharts = lazy(() => import("./pages/DipCharts"));
const Prices = lazy(() => import("./pages/Prices"));
const Alerts = lazy(() => import("./pages/Alerts"));
const Automations = lazy(() => import("./pages/Automations"));
const SettingsPage = lazy(() => import("./pages/Settings"));
const Lists = lazy(() => import("./pages/Lists"));
const Users = lazy(() => import("./pages/Users"));
const Wholesale = lazy(() => import("./pages/Wholesale"));
const Expenses = lazy(() => import("./pages/Expenses"));
const Property = lazy(() => import("./pages/Property"));
const Reports = lazy(() => import("./pages/Reports"));
const Suppliers = lazy(() => import("./pages/Suppliers"));
const Carriage = lazy(() => import("./pages/Carriage"));
const Staff = lazy(() => import("./pages/Staff"));
const MyAccount = lazy(() => import("./pages/MyAccount"));
const Cards = lazy(() => import("./pages/Cards"));
const Cash = lazy(() => import("./pages/Cash"));
const Shop = lazy(() => import("./pages/Shop"));
const Compliance = lazy(() => import("./pages/Compliance"));
const ChecklistPage = lazy(() => import("./pages/ChecklistPage"));
const Insights = lazy(() => import("./pages/Insights"));
const Bookings = lazy(() => import("./pages/Bookings"));
const Register = lazy(() => import("./pages/Register"));
const Prepaid = lazy(() => import("./pages/Prepaid"));
const CouponSheet = lazy(() => import("./pages/Prepaid").then((m) => ({ default: m.CouponSheet })));
const Team = lazy(() => import("./pages/Team"));
const Accounts = lazy(() => import("./pages/Accounts"));
const Setup = lazy(() => import("./pages/Setup"));
const Audit = lazy(() => import("./pages/Audit"));
const SecurityScore = lazy(() => import("./pages/SecurityScore"));
const Machines = lazy(() => import("./pages/Machines"));
const Cashier = lazy(() => import("./pages/Cashier"));
const Suggestions = lazy(() => import("./pages/Suggestions"));
const CardPending = lazy(() => import("./pages/CardPending"));
const OwnerReport = lazy(() => import("./pages/OwnerReport"));
const DiscountReport = lazy(() => import("./pages/DiscountReport"));
const OtherEntries = lazy(() => import("./pages/OtherEntries"));
const Corrections = lazy(() => import("./pages/Corrections"));
const SalesHistory = lazy(() => import("./pages/SalesHistory"));
const OpeningBalances = lazy(() => import("./pages/OpeningBalances"));
const GoLive = lazy(() => import("./pages/GoLive"));
const Margins = lazy(() => import("./pages/Margins"));
const ProfitExplainer = lazy(() => import("./pages/ProfitExplainer"));
const Roster = lazy(() => import("./pages/Roster"));
const Kiosk = lazy(() => import("./pages/Kiosk"));
import { loadBranding, applyBrand, setPumpSlug, applyPumpManifest } from "./lib/brand";
import { useParams } from "react-router-dom";

/** A pump's own sign-in link (/p/<slug>): remember the pump, then show its sign-in page. */
function PumpLink() {
  const { slug } = useParams();
  setPumpSlug(slug ?? null);
  return <Navigate to={`/login?pump=${encodeURIComponent(slug ?? "")}`} replace />;
}
const Activate = lazy(() => import("./pages/Activate"));
const AttendPublic = lazy(() => import("./pages/AttendPublic"));
const Platform = lazy(() => import("./pages/Platform"));

loadBranding().catch(() => {});

type User = { id: number; name: string; email: string; role: "admin" | "manager" | "salesman" | "wholesale" | "cashier"; tenant_id: number; station_id: number | null; station_name: string | null };
type Account = { saas: boolean; locked?: boolean; status?: string; days_left?: number };
type Modules = { wholesale: boolean };
type Auth = {
  user: User | null; tenant: { id: number; name: string; color?: string | null; logo_url?: string | null } | null; permissions: string[]; account: Account; modules: Modules;
  can: (perm: string) => boolean; login: (token: string) => Promise<void>; logout: () => void; refresh: () => Promise<void>;
};
export const ROLE_LABEL: Record<string, string> = { admin: "Admin (CEO)", manager: "Manager", salesman: "Salesman", wholesale: "Wholesale Officer", cashier: "Cashier", staff: "Staff (no login)" };
const AuthCtx = createContext<Auth>(null as unknown as Auth);
export const useAuth = () => useContext(AuthCtx);
/** After sign-in the whole app wears the pump's own brand: colour + tab title (the logo/name come from `tenant` in Layout). */
function brandFor(t: { name?: string; color?: string | null; slug?: string | null } | null) {
  if (!t) return;
  if (t.color) applyBrand(t.color);
  if (t.name) document.title = t.name; // the pump's own name only — the installed app's title bar already carries the app name
  if (t.slug) { setPumpSlug(t.slug); applyPumpManifest(t.slug, t.name); } // the signed-in pump becomes this device's pump
}

function AuthProvider({ children }: { children: ReactNode }) {
  const empty = { user: null, tenant: null, permissions: [] as string[], account: { saas: false } as Account, modules: { wholesale: false } as Modules, ready: true };
  const [state, setState] = useState<{ user: User | null; tenant: Auth["tenant"]; permissions: string[]; account: Account; modules: Modules; ready: boolean }>({ ...empty, ready: false });
  const load = async () => {
    if (!getToken()) return setState(empty);
    try {
      const me = await api("/me");
      setMediaToken(me.media_token);
      loadLookups().catch(() => {}); // admin-managed lists for every dropdown
      loadProducts().catch(() => {}); // admin-managed fuel products
      brandFor(me.tenant);
      setState({ user: me.user, tenant: me.tenant, permissions: me.permissions, account: me.account ?? { saas: false }, modules: me.modules ?? { wholesale: false }, ready: true });
    } catch {
      setState(empty);
    }
  };
  useEffect(() => { load(); }, []);
  // rights can be changed by the admin at any time: pick them up when the app comes back to the screen
  useEffect(() => {
    const again = () => { if (document.visibilityState === "visible" && getToken()) api("/me").then((me) => { setMediaToken(me.media_token); setState((s) => ({ ...s, user: me.user, tenant: me.tenant, permissions: me.permissions, modules: me.modules ?? s.modules })); }).catch(() => {}); };
    document.addEventListener("visibilitychange", again);
    const t = setInterval(again, 5 * 60_000);
    return () => { document.removeEventListener("visibilitychange", again); clearInterval(t); };
  }, []);
  const value: Auth = {
    user: state.user, tenant: state.tenant, permissions: state.permissions, account: state.account, modules: state.modules,
    can: (perm) => state.permissions.includes(perm),
    login: async (token) => { setToken(token); await load(); },
    logout: () => { setToken(null); setState(empty); },
    refresh: load,
  };
  if (!state.ready) return <Loading />;
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

function Protected({ children }: { children: ReactNode }) {
  const { user, account } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  // SaaS: a locked pump (trial over / suspended) only sees the activate screen
  if (account.saas && account.locked) return <Activate />;
  return <>{children}</>;
}

/** Route guard: shows a friendly "no access" page instead of the screen. */
function Need({ perm, children }: { perm: string; children: ReactNode }) {
  const { can, user } = useAuth();
  if (perm.split("|").some(can)) return <>{children}</>;
  return (
    <div className="card mx-auto mt-10 max-w-md p-6 text-center">
      <div className="text-4xl">🔒</div>
      <h1 className="mt-2 text-lg font-semibold">No access</h1>
      <p className="mt-1 text-sm text-slate-600">Your role ({ROLE_LABEL[user?.role ?? ""]}) can't open this page. Ask your admin if you need access.</p>
    </div>
  );
}

/** Managers/admins land on the dashboard; other roles land on their main screen. */
function Home() {
  const { can } = useAuth();
  if (can("dashboard.view")) return <Dashboard />;
  return <Navigate to={can("wholesale.view") ? "/wholesale" : can("cashier.desk") ? "/cashier" : "/pos"} replace />;
}

export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <UpdateBanner />
        <LightboxHost />
        <PinPrompt />
        <CancelHost />
        <BrowserRouter>
          <Suspense fallback={<Loading />}>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/a/:token" element={<AttendPublic />} />
            <Route path="/p/:slug" element={<PumpLink />} />
            <Route path="/setup" element={<Setup />} />
            <Route path="/signup" element={<Setup signup />} />
            <Route path="/platform" element={<Platform />} />
            <Route element={<Protected><Layout /></Protected>}>
              <Route index element={<Home />} />
              <Route path="inbox" element={<Need perm="whatsapp.inbox"><Inbox /></Need>} />
              <Route path="inbox/:id" element={<Need perm="whatsapp.inbox"><Inbox /></Need>} />
              <Route path="customers" element={<Need perm="customers.edit"><Customers /></Need>} />
              <Route path="customers/:id" element={<Need perm="customers.edit"><Customers /></Need>} />
              <Route path="khata" element={<Need perm="khata.manage"><Khata /></Need>} />
              <Route path="orders" element={<Need perm="orders.manage"><Orders /></Need>} />
              <Route path="complaints" element={<Need perm="complaints.manage"><Complaints /></Need>} />
              <Route path="campaigns" element={<Need perm="campaigns.manage"><Campaigns /></Need>} />
              <Route path="pos" element={<Need perm="sales.create"><Pos /></Need>} />
              <Route path="shifts" element={<Need perm="shifts.manage"><Shifts /></Need>} />
              <Route path="stock" element={<Need perm="stock.manage"><Stock /></Need>} />
              <Route path="dip-charts" element={<Need perm="stock.manage"><DipCharts /></Need>} />
              <Route path="prices" element={<Need perm="prices.update"><Prices /></Need>} />
              <Route path="alerts" element={<Need perm="alerts.view"><Alerts /></Need>} />
              <Route path="automations" element={<Need perm="automations.manage"><Automations /></Need>} />
              <Route path="wholesale" element={<Need perm="wholesale.view"><Wholesale /></Need>} />
              <Route path="wholesale/:id" element={<Need perm="wholesale.view"><Wholesale /></Need>} />
              <Route path="carriage" element={<Need perm="carriage.view"><Carriage /></Need>} />
              <Route path="carriage/:id" element={<Need perm="carriage.view"><Carriage /></Need>} />
              <Route path="expenses" element={<Need perm="expenses.view"><Expenses /></Need>} />
              <Route path="property" element={<Need perm="expenses.view"><Property /></Need>} />
              <Route path="reports" element={<Need perm="reports.view"><Reports /></Need>} />
              <Route path="sales-history" element={<Need perm="sales.view"><SalesHistory /></Need>} />
              <Route path="owner-report" element={<Need perm="reports.view"><OwnerReport /></Need>} />
              <Route path="discounts-report" element={<Need perm="reports.view"><DiscountReport /></Need>} />
              <Route path="other-entries" element={<Need perm="other_entries.manage"><OtherEntries /></Need>} />
              <Route path="corrections" element={<Need perm="corrections.manage"><Corrections /></Need>} />
              <Route path="opening-balances" element={<Need perm="opening.manage"><OpeningBalances /></Need>} />
              <Route path="go-live" element={<Need perm="settings.manage"><GoLive /></Need>} />
              <Route path="margins" element={<Need perm="reports.view"><Margins /></Need>} />
              <Route path="profit" element={<Need perm="reports.view"><ProfitExplainer /></Need>} />
              <Route path="help" element={<Help />} />
              <Route path="suppliers" element={<Need perm="suppliers.manage"><Suppliers /></Need>} />
              <Route path="users" element={<Need perm="users.manage"><Users /></Need>} />
              <Route path="settings" element={<Need perm="settings.manage"><SettingsPage /></Need>} />
              <Route path="lists" element={<Need perm="settings.manage"><Lists /></Need>} />
              <Route path="staff" element={<Need perm="staff.manage"><Staff /></Need>} />
              <Route path="kiosk" element={<Need perm="staff.manage"><Kiosk /></Need>} />
              <Route path="roster" element={<Need perm="staff.manage"><Roster /></Need>} />
              <Route path="my-account" element={<MyAccount />} />
              <Route path="cash" element={<Need perm="expenses.view|cash.book"><Cash /></Need>} />
              <Route path="cashier" element={<Need perm="cashier.desk"><Cashier /></Need>} />
              <Route path="shop" element={<Need perm="stock.manage"><Shop /></Need>} />
              <Route path="compliance" element={<Need perm="alerts.view"><Compliance /></Need>} />
              <Route path="checklist" element={<Need perm="sales.create"><ChecklistPage /></Need>} />
              <Route path="insights" element={<Need perm="reports.view"><Insights /></Need>} />
              <Route path="suggestions" element={<Need perm="dashboard.view|wholesale.view"><Suggestions /></Need>} />
              <Route path="bookings" element={<Need perm="sales.create"><Bookings /></Need>} />
              <Route path="register" element={<Need perm="stock.manage"><Register /></Need>} />
              <Route path="prepaid" element={<Need perm="khata.manage"><Prepaid /></Need>} />
              <Route path="card-pending" element={<Need perm="khata.clear_pending"><CardPending /></Need>} />
              <Route path="team" element={<Need perm="staff.manage"><Team /></Need>} />
              <Route path="accounts" element={<Need perm="reports.view"><Accounts /></Need>} />
              <Route path="audit" element={<Need perm="audit.view"><Audit /></Need>} />
              <Route path="security" element={<Need perm="settings.manage"><SecurityScore /></Need>} />
              <Route path="machines" element={<Need perm="sales.create"><Machines /></Need>} />
            </Route>
            <Route path="/cards/:id" element={<Protected><Need perm="khata.manage"><Cards /></Need></Protected>} />
            <Route path="/coupons/:batch" element={<Protected><Need perm="khata.manage"><CouponSheet /></Need></Protected>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          </Suspense>
        </BrowserRouter>
      </AuthProvider>
    </ToastProvider>
  );
}
